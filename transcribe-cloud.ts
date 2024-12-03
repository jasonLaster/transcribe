#!/usr/bin/env bun
import { program } from 'commander';
import OpenAI from 'openai';
import { createReadStream } from 'node:fs';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function getAudioDuration(file: string): Promise<number> {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`
  );
  return parseFloat(stdout.trim());
}

async function transcribeChunk(
  openai: OpenAI,
  audioFile: string,
  startTime: number,
  duration: number,
  outputDir: string
): Promise<string> {
  const chunkFile = join(outputDir, `chunk-${startTime}.mp3`);
  await execAsync(
    `ffmpeg -i "${audioFile}" -ss ${startTime} -t ${duration} -vn -acodec libmp3lame "${chunkFile}"`
  );

  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(chunkFile),
    model: 'whisper-1', // Already using fastest Whisper model
    language: 'en',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'], // Removed 'word' granularity for speed
  });

  // Format the response with timestamps
  const segments = transcription.segments.map(segment => {
    const timestamp = Math.floor(segment.start + startTime);
    const minutes = Math.floor(timestamp / 60);
    const seconds = timestamp % 60;
    const timeStr = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
    return `${timeStr} ${segment.text.trim()}`;
  });

  return segments.join('\n');
}

async function generateFormattedScript(transcription: string) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `
        You are an expert at formatting transcripts.
        Format the following transcript with speaker names and timestamps.
        Use your best judgment to identify different speakers and speaking patterns.
        
        Important: Ensure that NO words are dropped or omitted from the original transcript.
        Preserve every single word while formatting.
        
        Format it like this:
        [00:00] Speaker Name: text
        [00:30] Different Speaker: text
        
        Remember to include ALL words from the original transcript in your formatted output.`
      },
      {
        role: "user",
        content: transcription
      }
    ],
  });

  return completion.choices[0].message.content;
}

async function formatTranscription(transcription: string, outputDir: string) {
  console.log('\nGenerating formatted script with speakers...');

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\rFormatting ${spinner[i]} `);
    i = (i + 1) % spinner.length;
  }, 100);

  // Break transcript into 10 chunks for more reliable formatting
  const formattedScript = await generateFormattedScript(transcription);

  clearInterval(interval);
  process.stdout.write('\r');

  const formattedOutputFile = join(outputDir, 'transcription.formatted.txt');
  await writeFile(formattedOutputFile, formattedScript);
  console.log(`Formatted script saved in: ${formattedOutputFile}`);
  console.log('\nFormatted Script Preview:');
  console.log(formattedScript.slice(0, 500) + '...');

  return formattedScript;
}

program
  .name('transcribe-cloud')
  .description('Transcribe video files using OpenAI Whisper API')
  .command('transcribe')
  .argument('<file>', 'video file to transcribe')
  .option('-d, --duration <minutes>', 'duration to transcribe in minutes')
  .option('-o, --offset <minutes>', 'start time offset in minutes', '0')
  .action(async (file, options) => {
    try {
      const startTime = performance.now();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDir = join('output', timestamp);
      await mkdir(outputDir, { recursive: true });

      console.log('Starting transcription...');
      console.log('Using OpenAI Whisper API');

      const startSeconds = parseFloat(options.offset) * 60;
      const duration = options.duration ? parseFloat(options.duration) * 60 : undefined;

      const CHUNK_SIZE = 24 * 60; // 24 minutes per chunk
      const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB limit

      let audioFile = file;
      let totalDuration: number;

      if (duration) {
        totalDuration = duration;
        const trimmedFile = join(outputDir, 'trimmed-audio.mp3');
        console.log(`Trimming audio from ${startSeconds}s to ${startSeconds + duration}s...`);
        await execAsync(
          `ffmpeg -i "${file}" -ss ${startSeconds} -t ${duration} -vn -acodec libmp3lame "${trimmedFile}"`
        );
        audioFile = trimmedFile;
      } else {
        totalDuration = await getAudioDuration(file);
      }

      console.log(`Total duration: ${totalDuration} seconds`);
      const audioChunks = Math.ceil(totalDuration / CHUNK_SIZE);
      console.log(`Processing in ${audioChunks} chunks...`);

      let fullTranscription = '';
      for (let i = 0; i < audioChunks; i++) {
        const chunkStart = i * CHUNK_SIZE;
        const chunkDuration = Math.min(CHUNK_SIZE, totalDuration - chunkStart);

        console.log(`\nProcessing chunk ${i + 1}/${audioChunks} (${chunkDuration}s)...`);
        const chunkText = await transcribeChunk(
          openai,
          audioFile,
          chunkStart,
          chunkDuration,
          outputDir
        );

        fullTranscription += chunkText + '\n';

        // Save intermediate results
        await writeFile(
          join(outputDir, 'transcription-in-progress.txt'),
          fullTranscription
        );
      }

      const duration_seconds = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`\nTranscription completed in ${duration_seconds}s`);

      // Save the final transcription
      const outputFile = join(outputDir, 'transcription.txt');
      await writeFile(outputFile, fullTranscription);
      console.log(`\nTranscript saved in: ${outputFile}`);

      await formatTranscription(fullTranscription, outputDir);

    } catch (error) {
      console.error('Error during transcription:', error);
      process.exit(1);
    }
  });

// Add new command to format existing transcription
program
  .command('format')
  .description('Format an existing transcription file with speaker names and timestamps')
  .argument('<file>', 'transcription file to format')
  .action(async (file) => {
    try {
      // Get the directory of the input file
      const inputDir = join(file, '..');
      const inputFileName = file.split('/').pop()?.replace('.txt', '') || 'transcript';

      console.log('Reading transcription file...');
      const transcription = await readFile(file, 'utf-8');

      await formatTranscription(transcription, inputDir);

    } catch (error) {
      console.error('Error during formatting:', error);
      process.exit(1);
    }
  });

program.parse(); 