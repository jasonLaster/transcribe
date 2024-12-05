import { TranscriptEntry } from '../data/transcript';

export function parseTranscript(text: string): TranscriptEntry[] {
  const lines = text.split('\n').filter(line => line.trim());
  const transcript: TranscriptEntry[] = [];

  for (const line of lines) {
    // Skip any lines with NaN
    if (line.includes('NaN')) continue;

    const timeMatch = line.match(/\[(\d+):(\d+)\]/);
    if (timeMatch) {
      const minutes = parseInt(timeMatch[1], 10);
      const seconds = parseInt(timeMatch[2], 10);
      const time = minutes * 60 + seconds;
      const text = line.replace(/\[\d+:\d+\]/, '').trim();
      if (text) {
        transcript.push({ time, text });
      }
    }
  }

  return transcript;
}