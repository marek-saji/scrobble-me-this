#!/usr/bin/env node

import { parseArgs } from "node:util";
import fs from "node:fs/promises"
import crypto from "node:crypto";

import { parse } from "csv-parse/sync";

const options = {
  "api-key": {
    type: "string",
    short: "k",
    description: "Last.fm API key",
    required: true
  },
  "api-secret": {
    type: "string",
    short: "s",
    description: "Last.fm API secret",
    required: true
  },
  "username": {
    type: "string",
    short: "u",
    description: "Last.fm username",
    required: true
  },
  "password": {
    type: "string",
    short: "p",
    description: "Last.fm password",
    required: true
  },
  "delimiter": {
    type: "string",
    short: "d",
    default: ",",
    description: "CSV delimiter"
  },
  "header": {
    type: "boolean",
    short: "H",
    default: false,
    description: "CSV has header row (recognised headers: artist, track, title)"
  },
  "debug": {
    type: "boolean",
    short: "D",
    default: false,
    description: "Show debug output"
  },
  "help": {
    type: "boolean",
    short: "h",
    description: "Show this help message"
  }
};

function printHelp () {
  const help = [
    "Usage:",
    "scrobble-me-this OPTIONS CSV_FILE",
    "cat CSV_FILE | scrobble-me-this OPTIONS",
    "",
    "Options:",
  ]

  Object.entries(options).forEach(([name, opt]) => {
    const shortOpt = opt.short ? `-${opt.short}, ` : '    ';
    let description = opt.description;

    // Add required/default information if applicable
    if (opt.required) {
      description += " (required)";
    } else if (opt.default !== undefined) {
      description += ` (default: "${opt.default}")`;
    }

    help.push(`${shortOpt}--${name.padEnd(12)} ${description}`);
  });

  help.push(
    "",
    "Getting Last.fm API Credentials:",
    "1. Go to <https://www.last.fm/api/account/create>",
    "2. Create a new API account",
    "3. Note your API key and API secret",
    "4. Use your regular Last.fm username and password for authentication",
    ""
  );

  process.stdout.write(help.join("\n"));
}

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function createSignature(params, apiSecret) {
  const signatureData = [
    ...Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .flat(),
    apiSecret,
  ]

  return md5(signatureData.join(''));
}

async function lastFmRequest(params) {
  const apiSecret = values["api-secret"];

  const response = await fetch(
    "https://ws.audioscrobbler.com/2.0/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        api_sig: createSignature(params, apiSecret),
        format: "json"
      })
    }
  );

  return response.json();
}

async function getAuthToken() {
  const data = await lastFmRequest({
    api_key: values["api-key"],
    method: "auth.getMobileSession",
    username: values["username"],
    authToken: md5(`${values["username"]}${md5(values["password"])}`),
  });

  if (data.error) {
    throw new Error(`Last.fm authentication error: ${data.message}`, { cause: data });
  }

  return data.session.key;
}

async function scrobbleTrack(sessionKey, artist, track, timestamp) {
  const data = await lastFmRequest({
    method: "track.scrobble",
    api_key: values["api-key"],
    sk: sessionKey,
    artist,
    track,
    timestamp,
  });

  if (data.error) {
    throw new Error(`Last.fm scrobbling error: ${data.message}`, { cause: data });
  }

  return data;
}

async function readInput () {
  // Read CSV data
  let csvData = "";

  if (positionals.length > 0) {
    csvData = await fs.readFile(positionals[0], 'utf8');
  } else {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      csvData += chunk;
    }
  }

  return csvData;
}

async function parseCsv(csvData) {
  const records = parse(csvData, {
    delimiter: values.delimiter,
    columns: values.header,
    skip_empty_lines: true,
    trim: true
  });

  return records;
}


const { values, positionals } = parseArgs({ options, allowPositionals: true });

if (values.help) {
  printHelp();
  process.exit(0);
}

for (const [param, config] of Object.entries(options)) {
  if (config.required && !values[param]) {
    process.stderr.write(`Error: ${param} is required\n`);
    process.exit(1);
  }
}

try {
  // Authenticate with Last.fm
  process.stdout.write("Authenticating with Last.fm...\n");
  const sessionKey = await getAuthToken();
  process.stdout.write("Authentication successful\n");

  // Read input
  const csvData = await readInput();
  const records = await parseCsv(csvData);
  process.stdout.write(`Found ${records.length} tracks to scrobble\n`);

  // Process tracks
  let successCount = 0;
  let errorCount = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    // Get artist and track from the record
    let artist, track;

    if (values.header) {
      // If CSV has headers, try to find columns by name
      artist = record.artist || record.Artist;
      track = record.track || record.Track || record.title || record.Title;
    } else {
      // If no headers, assume first column is artist, second is track
      artist = Object.values(record)[0];
      track = Object.values(record)[1];
    }

    if (!artist || !track) {
      process.stderr.write(`Error: Could not determine artist and track from line ${i + 1}\n`);
      errorCount++;
      continue;
    }

    try {
      // Scrobble with timestamp 30 seconds apart to avoid Last.fm rate limits
      const timestamp = Math.floor(Date.now() / 1000) - (records.length - i) * 30;

      await scrobbleTrack(sessionKey, artist, track, timestamp);
      process.stdout.write(`Scrobbled: ${artist} - ${track}\n`);
      successCount++;

      // Small delay to prevent hammering the API
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      process.stderr.write(`Error scrobbling "${artist} - ${track}": ${error.message}\n`);
      errorCount++;
    }
  }

  process.stdout.write(`\nScrobbling complete: ${successCount} successful, ${errorCount} failed\n`);
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  if (values.debug) {
    throw error;
  } else {
    process.exit(1);
  }
}