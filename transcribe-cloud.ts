#!/usr/bin/env bun
import { program } from 'commander';
import OpenAI from 'openai';
import { createReadStream } from 'node:fs';
import { writeFile, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { AssemblyAI } from 'assemblyai';

const execAsync = promisify(exec);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const assemblyClient = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY || ''
});

// Add this new type near the top of the file
type FormattingModel = 'gpt';
type TranscriptionModel = 'whisper' | 'assemblyai';

// Add these types near the top of the file
interface AssemblyAIUtterance {
  text: string;
  start: number;
  speaker: string;
}

interface AssemblyAIResponse {
  status: string;
  error?: string;
  utterances?: AssemblyAIUtterance[];
}

type TranscriptionService = 'whisper' | 'assemblyai';

// Add this interface for LeMUR questions
interface LemurQuestion {
  question: string;
  answer_format: string;
}

interface TranscriptionResult {
  raw: string;
  consolidated: string;
}

async function getAudioDuration(file: string): Promise<number> {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`
  );
  return parseFloat(stdout.trim());
}

async function transcribeWithAssemblyAI(audioFile: string): Promise<TranscriptionResult> {
  console.log('Starting AssemblyAI transcription...');
  const startTime = performance.now();

  try {
    // Extract audio to MP3 first
    console.log('Extracting audio...');
    const outputDir = dirname(audioFile);
    const audioPath = join(outputDir, 'temp-audio.mp3');

    // Use a more efficient audio extraction
    await execAsync(
      `ffmpeg -i "${audioFile}" -vn -acodec libmp3lame -q:a 4 -map_metadata -1 "${audioPath}"`
    );
    console.log('Audio extraction complete');

    // Upload progress
    console.log('Uploading audio file...');

    // Create form data with chunked file reading
    const fileBuffer = await readFile(audioPath);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: 'audio/mpeg' }));

    try {
      // Upload with retries
      let uploadUrl: string | null = null;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts && !uploadUrl) {
        try {
          const response = await fetch('https://api.assemblyai.com/v2/upload', {
            method: 'POST',
            headers: {
              'Authorization': process.env.ASSEMBLYAI_API_KEY || ''
            },
            body: formData
          });

          if (!response.ok) {
            throw new Error(`Upload failed with status ${response.status}: ${response.statusText}`);
          }

          const data = await response.json();
          uploadUrl = data.upload_url;
          console.log('Upload complete!');
        } catch (error) {
          attempts++;
          console.error(`Upload attempt ${attempts} failed:`, error);

          if (attempts === maxAttempts) {
            throw new Error(`Failed to upload after ${maxAttempts} attempts`);
          }

          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }

      if (!uploadUrl) {
        throw new Error('Upload failed - no upload URL received');
      }

      // Start transcription
      const config = {
        audio_url: uploadUrl,
        speaker_labels: true,
        speakers_expected: 10,
        language_code: "en",
        format_text: true,
      };

      console.log('Starting transcription...');
      const transcriptResponse = await assemblyClient.transcripts.create(config);

      // Poll for completion with better progress reporting
      let transcriptResult = await assemblyClient.transcripts.get(transcriptResponse.id);
      let lastStatus = '';

      while (transcriptResult.status !== 'completed') {
        if (transcriptResult.status === 'error') {
          throw new Error(`Transcription failed: ${transcriptResult.error}`);
        }

        // Show detailed status
        const status = (() => {
          switch (transcriptResult.status) {
            case 'queued': return 'Queued in processing line...';
            case 'processing': return 'Processing audio...';
            case 'analyzing': return 'Analyzing speakers...';
            default: return transcriptResult.status;
          }
        })();

        if (status !== lastStatus) {
          console.log(status);
          lastStatus = status;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        transcriptResult = await assemblyClient.transcripts.get(transcriptResponse.id);
      }

      console.log('Transcription complete! Processing results...');

      if (!transcriptResult.utterances) {
        throw new Error('No utterances found in transcription');
      }

      // Create text with speaker labels for LeMUR
      let text_with_speaker_labels = "";
      for (const utt of transcriptResult.utterances) {
        text_with_speaker_labels += `Speaker ${utt.speaker}:\n${utt.text}\n`;
      }

      // Get unique speakers
      const unique_speakers = new Set(transcriptResult.utterances.map(utt => utt.speaker));

      // Create questions for LeMUR
      const questions: LemurQuestion[] = Array.from(unique_speakers).map(speaker => ({
        question: `Who is speaker ${speaker}?`,
        answer_format: "<First Name> <Last Name (if applicable)>"
      }));

      // Ask LeMUR to identify speakers
      const lemurResult = await assemblyClient.lemur.questionAnswer({
        questions,
        input_text: text_with_speaker_labels,
        context: "Your task is to infer the speaker's name from the speaker-labelled transcript"
      });

      // Create speaker mapping from LeMUR responses
      const speakerMap = new Map<string, string>();
      for (const qa_response of lemurResult.response) {
        const match = qa_response.question.match(/Who is speaker (\w)\?/);
        if (match && match[1] && !speakerMap.has(match[1])) {
          speakerMap.set(match[1], qa_response.answer);
        }
      }

      // Format transcript with identified speaker names - use transcriptResult instead of lemurResult
      const segments = transcriptResult.utterances.map((utterance) => {
        const speakerName = speakerMap.get(utterance.speaker) || `Speaker ${utterance.speaker}`;
        const timestamp = Math.floor(utterance.start / 1000);
        const minutes = Math.floor(timestamp / 60);
        const seconds = timestamp % 60;
        const timeStr = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;

        return `${timeStr} ${speakerName}: ${utterance.text}`;
      });

      const rawTranscript = segments.join('\n');
      const consolidatedTranscript = consolidateSegments(rawTranscript);

      const duration = Date.now() - startTime;
      console.log(`AssemblyAI transcription complete in ${duration}ms`);

      return {
        raw: rawTranscript,
        consolidated: consolidatedTranscript
      };
    } finally {
      // Clean up the temporary audio file
      try {
        await unlink(audioPath);
      } catch (error) {
        console.error('Failed to clean up temporary audio file:', error);
      }
    }
  } catch (error) {
    throw error;
  }
}

async function transcribeChunk(
  openai: OpenAI,
  audioFile: string,
  startTime: number,
  duration: number,
  outputDir: string,
  service: TranscriptionService = 'whisper'
): Promise<TranscriptionResult> {
  const chunkFile = join(outputDir, `chunk-${startTime}.mp3`);
  await execAsync(
    `ffmpeg -i "${audioFile}" -ss ${startTime} -t ${duration} -vn -acodec libmp3lame "${chunkFile}"`
  );

  switch (service) {
    case 'whisper':
      const transcription = await openai.audio.transcriptions.create({
        file: createReadStream(chunkFile),
        model: 'whisper-1',
        language: 'en',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
      });

      if (!transcription.segments) {
        throw new Error('No segments found in transcription');
      }

      // Format the response with timestamps
      const segments = transcription.segments.map(segment => {
        const timestamp = Math.floor(segment.start + startTime);
        const minutes = Math.floor(timestamp / 60);
        const seconds = timestamp % 60;
        const timeStr = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
        return `${timeStr} ${segment.text.trim()}`;
      });

      const raw = segments.join('\n');
      return {
        raw,
        consolidated: consolidateSegments(raw)
      };

    case 'assemblyai':
      return await transcribeWithAssemblyAI(chunkFile);

    default:
      throw new Error(`Unsupported transcription service: ${service}`);
  }
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

async function formatTranscription(
  transcription: string,
  outputDir: string,
): Promise<string> {
  console.log('\nGenerating formatted script with speakers using GPT...');

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\rFormatting ${spinner[i]} `);
    i = (i + 1) % spinner.length;
  }, 100);

  let formattedScript: string;
  try {
    formattedScript = await generateFormattedScript(transcription);
  } catch (error) {
    clearInterval(interval);
    throw error;
  }

  if (!formattedScript) {
    throw new Error('Failed to generate formatted script');
  }

  clearInterval(interval);
  process.stdout.write('\r');

  const formattedOutputFile = join(outputDir, 'transcription.formatted.txt');
  await writeFile(formattedOutputFile, formattedScript);
  console.log(`Formatted script saved in: ${formattedOutputFile}`);
  console.log('\nFormatted Script Preview:');
  console.log(formattedScript.slice(0, 500) + '...');

  return formattedScript;
}

interface TranscriptSegment {
  timestamp: number;
  speaker: string;
  text: string;
}

function consolidateSegments(transcript: string): string {
  // Parse the transcript into segments
  const segments: TranscriptSegment[] = transcript.split('\n').map(line => {
    const match = line.match(/\[(\d{2}):(\d{2})\] (.*?): (.*)/);
    if (!match) return null;
    const [_, minutes, seconds, speaker, text] = match;
    return {
      timestamp: parseInt(minutes) * 60 + parseInt(seconds),
      speaker,
      text,
    };
  }).filter((s): s is TranscriptSegment => s !== null);

  // Consolidate segments
  const consolidated: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;
  let currentStartTime: number | null = null;

  for (const segment of segments) {
    if (!current) {
      current = segment;
      currentStartTime = segment.timestamp;
      continue;
    }

    const timeDiff = segment.timestamp - current.timestamp;
    const totalTimeDiff = segment.timestamp - (currentStartTime || segment.timestamp);
    const isSameSpeaker = segment.speaker === current.speaker;
    const isUnderTimeLimit = totalTimeDiff < 30; // Check total time from start of consolidated segment (30s limit)
    const startsWithSlide = segment.text.toLowerCase().trim().startsWith('going to slide') ||
      segment.text.toLowerCase().trim().startsWith('slide');

    if (isSameSpeaker && isUnderTimeLimit && !startsWithSlide) {
      current.text += ' ' + segment.text;
    } else {
      consolidated.push(current);
      current = segment;
      currentStartTime = segment.timestamp;
    }
  }

  if (current) {
    consolidated.push(current);
  }

  // Format back to string
  return consolidated.map(segment => {
    const minutes = Math.floor(segment.timestamp / 60);
    const seconds = segment.timestamp % 60;
    const timeStr = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
    return `${timeStr} ${segment.speaker}: ${segment.text}`;
  }).join('\n');
}

interface SlideReference {
  timestamp: string;
  slideNumber?: number;
  title?: string;
  context: string;
}

async function extractSlideTimestamps(transcript: string): Promise<SlideReference[]> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `
        Analyze the transcript and identify ALL mentions of slides.
        For each mention, extract:
        1. The timestamp
        2. The slide number if mentioned
        3. The slide title if mentioned or can be inferred from context
        4. The context of what was being discussed
        
        You must respond with a JSON object containing an array of slide references.
        Format your response as a JSON object with this structure:
        {
          "slides": [
            {
              "timestamp": "MM:SS",
              "slideNumber": number or null,
              "title": "slide title or null if not mentioned",
              "context": "brief description of what was being discussed"
            }
          ]
        }`
      },
      {
        role: "user",
        content: transcript
      }
    ],
    response_format: { type: "json_object" },
  });

  try {
    const response = JSON.parse(completion.choices[0].message.content || '{"slides": []}');
    return response.slides as SlideReference[];
  } catch (error) {
    console.error('Failed to parse slide references:', error);
    return [];
  }
}

// Update the slides data structure
interface SlidesData {
  references: SlideReference[];
  uniqueSlides: Array<{
    id: number;
    title: string | null;
    firstMention: string;
    allMentions: string[];
    context: string;
  }>;
}

program
  .name('transcribe-cloud')
  .description('Transcribe video files using OpenAI Whisper API')
  .command('transcribe')
  .description('Transcribe video files using AssemblyAI or Whisper')
  .argument('<file>', 'video file to transcribe')
  .option('-d, --duration <minutes>', 'duration to transcribe in minutes')
  .option('-o, --offset <minutes>', 'start time offset in minutes', '0')
  .option('-f, --format', 'format transcript with GPT-4', false)
  .option('-s, --no-slides', 'disable slide extraction', false)
  .option('-t, --service <service>', 'transcription service to use (assemblyai or whisper)', 'assemblyai')
  .action(async (file, options) => {
    try {
      const startTime = performance.now();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDir = join('output', timestamp);
      await mkdir(outputDir, { recursive: true });

      console.log('Starting transcription process...');
      console.log(`Using ${options.service.toUpperCase()} for transcription`);

      const startSeconds = parseFloat(options.offset) * 60;
      const duration = options.duration ? parseFloat(options.duration) * 60 : undefined;

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

      // For AssemblyAI, we don't need to chunk the file
      let fullTranscription: TranscriptionResult;
      if (options.service === 'assemblyai') {
        fullTranscription = await transcribeWithAssemblyAI(audioFile);
      } else {
        // Existing Whisper chunking logic...
        const CHUNK_SIZE = 24 * 60;
        const audioChunks = Math.ceil(totalDuration / CHUNK_SIZE);
        console.log(`Processing in ${audioChunks} chunks...`);

        let rawParts: string[] = [];
        for (let i = 0; i < audioChunks; i++) {
          const chunkStart = i * CHUNK_SIZE;
          const chunkDuration = Math.min(CHUNK_SIZE, totalDuration - chunkStart);
          console.log(`\nProcessing chunk ${i + 1}/${audioChunks} (${chunkDuration}s)...`);
          const chunkResult = await transcribeChunk(
            openai,
            audioFile,
            chunkStart,
            chunkDuration,
            outputDir,
            'whisper'
          );
          rawParts.push(chunkResult.raw);
        }

        const rawTranscription = rawParts.join('\n');
        fullTranscription = {
          raw: rawTranscription,
          consolidated: consolidateSegments(rawTranscription)
        };
      }

      const duration_seconds = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`\nTranscription completed in ${duration_seconds}s`);

      // Save both versions
      const rawOutputFile = join(outputDir, 'transcription.raw.txt');
      const consolidatedOutputFile = join(outputDir, 'transcription.txt');
      await writeFile(rawOutputFile, fullTranscription.raw);
      await writeFile(consolidatedOutputFile, fullTranscription.consolidated);
      console.log(`\nRaw transcript saved in: ${rawOutputFile}`);
      console.log(`Consolidated transcript saved in: ${consolidatedOutputFile}`);

      // Extract slide timestamps by default unless disabled
      if (!options.noSlides) {
        console.log('\nExtracting slide references...');
        const slideRefs = await extractSlideTimestamps(fullTranscription.raw);

        // Group by slide number and create unique slides data
        const slideMap = new Map<number, {
          title: string | null;
          mentions: string[];
          firstMention: string;
          context: string;
        }>();

        for (const ref of slideRefs) {
          if (ref.slideNumber) {
            if (!slideMap.has(ref.slideNumber)) {
              slideMap.set(ref.slideNumber, {
                title: ref.title || null,
                mentions: [ref.timestamp],
                firstMention: ref.timestamp,
                context: ref.context
              });
            } else {
              const slide = slideMap.get(ref.slideNumber)!;
              slide.mentions.push(ref.timestamp);
              // Update title if we didn't have one before
              if (!slide.title && ref.title) {
                slide.title = ref.title;
              }
            }
          }
        }

        const slidesData: SlidesData = {
          references: slideRefs,
          uniqueSlides: Array.from(slideMap.entries()).map(([num, data]) => ({
            id: num,
            title: data.title,
            firstMention: data.firstMention,
            allMentions: data.mentions,
            context: data.context
          }))
        };

        const slidesFile = join(outputDir, 'slides.json');
        await writeFile(slidesFile, JSON.stringify(slidesData, null, 2));
        console.log('Slide references:', slideRefs.length);
        console.log('Unique slides:', slidesData.uniqueSlides.length);
        console.log('Slide data saved in:', slidesFile);
      }

      // Format the transcription if requested
      if (options.format) {
        await formatTranscription(fullTranscription.raw, outputDir);
      }

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
      const inputDir = join(file, '..');
      const transcription = await readFile(file, 'utf-8');
      await formatTranscription(transcription, inputDir);
    } catch (error) {
      console.error('Error during formatting:', error);
      process.exit(1);
    }
  });

program.parse(); 