#!/usr/bin/env bun
import { program } from 'commander';
import whisper, { type WhisperModel } from 'node-whisper';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus } from 'node:os';

// Configure PyTorch settings for optimal CPU performance
process.env.OMP_NUM_THREADS = String(Math.max(1, cpus().length - 1));
process.env.MKL_NUM_THREADS = String(Math.max(1, cpus().length - 1));

type Options = {
  model: WhisperModel;
  language: 'en';
  clip_timestamps?: string;
  output_format: 'txt';
  output_dir: string;
  verbose: boolean;
  device?: 'cpu';
  threads?: number;
};

program
  .name('transcribe')
  .description('Transcribe video files using Whisper')
  .argument('<file>', 'video file to transcribe')
  .option('-m, --model <model>', 'model to use (tiny, base, small, medium, large)', 'small')
  .option('-d, --duration <minutes>', 'duration to transcribe in minutes')
  .option('-o, --offset <minutes>', 'start time offset in minutes', '0')
  .option('--threads <number>', 'number of CPU threads to use', String(Math.max(1, cpus().length - 1)))
  .action(async (file, options) => {
    try {
      const startTime = performance.now();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDir = join('output', timestamp);
      await mkdir(outputDir, { recursive: true });

      console.log('Starting transcription...');
      console.log(`Using CPU with ${options.threads} threads`);
      console.log(`Model: ${options.model}`);

      const startSeconds = parseFloat(options.offset) * 60;
      const endSeconds = options.duration
        ? startSeconds + (parseFloat(options.duration) * 60)
        : undefined;

      const whisperOptions: Options = {
        model: options.model as WhisperModel,
        language: 'en',
        output_format: 'txt',
        output_dir: outputDir,
        verbose: true,
        device: 'cpu',
        threads: parseInt(options.threads),
        ...(endSeconds && { clip_timestamps: `${startSeconds},${endSeconds}` })
      };

      // Show a simple spinner while processing
      const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let i = 0;
      const interval = setInterval(() => {
        process.stdout.write(`\rTranscribing ${spinner[i]} `);
        i = (i + 1) % spinner.length;
      }, 100);

      const result = await whisper(file, whisperOptions);
      clearInterval(interval);
      process.stdout.write('\r');

      const transcription = result.txt.toString();
      const duration = ((performance.now() - startTime) / 1000).toFixed(1);

      console.log(`\nTranscription completed in ${duration}s:`);
      console.log(transcription);

      console.log(`\nTranscript saved in: ${outputDir}`);
    } catch (error) {
      console.error('Error during transcription:', error);
      process.exit(1);
    }
  });

program.parse(); 