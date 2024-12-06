import { expect, test, describe } from "bun:test";
import { consolidateSegments, formatTimestamp } from './transcribe-cloud';

// Helper function to create test input
function createTestTranscript(segments: { minutes: number; seconds: number; speaker: string; text: string }[]): string {
  return segments.map(({ minutes, seconds, speaker, text }) => {
    const formattedMinutes = minutes.toString().padStart(2, '0');
    const formattedSeconds = seconds.toString().padStart(2, '0');
    return `[${formattedMinutes}:${formattedSeconds}] ${speaker}: ${text}`;
  }).join('\n');
}

describe('formatTimestamp', () => {
  test('should format seconds into MM:SS format', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(61)).toBe('01:01');
    expect(formatTimestamp(3599)).toBe('59:59');
  });
});

describe('consolidateSegments', () => {
  test('should consolidate segments within 30-second window', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'Hello' },
      { minutes: 0, seconds: 5, speaker: 'Alice', text: 'how are you?' },
      { minutes: 0, seconds: 10, speaker: 'Alice', text: 'today?' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('[00:00] Alice: Hello how are you? today?');
  });

  test('should start new window after 30 seconds', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First segment' },
      { minutes: 0, seconds: 15, speaker: 'Alice', text: 'Still in first window' },
      { minutes: 0, seconds: 31, speaker: 'Alice', text: 'New window' },
      { minutes: 0, seconds: 45, speaker: 'Alice', text: 'Same window as 31' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:00] Alice: First segment Still in first window');
    expect(lines[1]).toBe('[00:31] Alice: New window Same window as 31');
  });

  test('should start new window on speaker change', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'Hello' },
      { minutes: 0, seconds: 5, speaker: 'Bob', text: 'Hi Alice' },
      { minutes: 0, seconds: 10, speaker: 'Bob', text: 'How are you?' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:00] Alice: Hello');
    expect(lines[1]).toBe('[00:05] Bob: Hi Alice How are you?');
  });

  test('should start new window on long pause (>1.5s)', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First part' },
      { minutes: 0, seconds: 2, speaker: 'Alice', text: 'Still first window' },
      { minutes: 0, seconds: 5, speaker: 'Alice', text: 'Long pause coming...' },
      { minutes: 0, seconds: 10, speaker: 'Alice', text: 'New window after pause' }, // >1.5s pause
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:00] Alice: First part Still first window Long pause coming...');
    expect(lines[1]).toBe('[00:10] Alice: New window after pause');
  });

  test('should handle edge case: empty input', () => {
    const input = '';
    const result = consolidateSegments(input);
    expect(result).toBe('');
  });

  test('should handle edge case: single segment', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'Single segment' },
    ]);

    const result = consolidateSegments(input);
    expect(result).toBe('[00:00] Alice: Single segment');
  });

  test('should handle edge case: segments at exactly 30s boundary', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First window' },
      { minutes: 0, seconds: 15, speaker: 'Alice', text: 'Still first window' },
      { minutes: 0, seconds: 30, speaker: 'Alice', text: 'Exactly at boundary' }, // Should start new window
      { minutes: 0, seconds: 45, speaker: 'Alice', text: 'Second window' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:00] Alice: First window Still first window');
    expect(lines[1]).toBe('[00:30] Alice: Exactly at boundary Second window');
  });

  test('should handle edge case: rapid speaker changes', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'Hello' },
      { minutes: 0, seconds: 2, speaker: 'Bob', text: 'Hi' },
      { minutes: 0, seconds: 4, speaker: 'Charlie', text: 'Hey' },
      { minutes: 0, seconds: 6, speaker: 'Alice', text: 'How are you all?' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe('[00:00] Alice: Hello');
    expect(lines[1]).toBe('[00:02] Bob: Hi');
    expect(lines[2]).toBe('[00:04] Charlie: Hey');
    expect(lines[3]).toBe('[00:06] Alice: How are you all?');
  });

  test('should handle edge case: long segments near window boundary', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'Start of first window' },
      { minutes: 0, seconds: 25, speaker: 'Alice', text: 'Near boundary...' },
      { minutes: 0, seconds: 32, speaker: 'Alice', text: 'Just after boundary' },
      { minutes: 0, seconds: 35, speaker: 'Alice', text: 'Still in second window' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:00] Alice: Start of first window Near boundary...');
    expect(lines[1]).toBe('[00:32] Alice: Just after boundary Still in second window');
  });

  test('should handle edge case: overlapping segments', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First segment' },
      { minutes: 0, seconds: 0, speaker: 'Bob', text: 'Overlapping segment' }, // Same timestamp
      { minutes: 0, seconds: 5, speaker: 'Alice', text: 'Another segment' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:00] Alice: First segment');
    expect(lines[1]).toBe('[00:00] Bob: Overlapping segment Another segment');
  });

  test('should handle edge case: very long segments', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'A'.repeat(1000) },
      { minutes: 0, seconds: 15, speaker: 'Alice', text: 'B'.repeat(1000) },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(`[00:00] Alice: ${'A'.repeat(1000)} ${'B'.repeat(1000)}`);
  });
});

describe('consolidateSegments edge cases', () => {
  test('should handle consecutive segments with small gaps', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First' },
      { minutes: 0, seconds: 1, speaker: 'Alice', text: 'Second' }, // 1s gap
      { minutes: 0, seconds: 2, speaker: 'Alice', text: 'Third' },  // 1s gap
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('[00:00] Alice: First Second Third');
  });

  test('should handle segments exactly at pause threshold', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First' },
      { minutes: 0, seconds: 1.5, speaker: 'Alice', text: 'Second' }, // 1.5s gap (threshold)
      { minutes: 0, seconds: 3, speaker: 'Alice', text: 'Third' },    // 1.5s gap (threshold)
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('[00:00] Alice: First Second Third');
  });

  test('should handle segments exactly at window boundary', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 29, speaker: 'Alice', text: 'End of first window' },
      { minutes: 0, seconds: 30, speaker: 'Alice', text: 'Start of second window' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:29] Alice: End of first window');
    expect(lines[1]).toBe('[00:30] Alice: Start of second window');
  });

  test('should handle mixed conditions', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First' },
      { minutes: 0, seconds: 1, speaker: 'Alice', text: 'Second' },    // Same window, no pause
      { minutes: 0, seconds: 3, speaker: 'Bob', text: 'Third' },       // Speaker change
      { minutes: 0, seconds: 5, speaker: 'Bob', text: 'Fourth' },      // Same speaker
      { minutes: 0, seconds: 7, speaker: 'Bob', text: 'Fifth' },       // Same speaker
      { minutes: 0, seconds: 10, speaker: 'Alice', text: 'Sixth' },    // Speaker change
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('[00:00] Alice: First Second');
    expect(lines[1]).toBe('[00:03] Bob: Third Fourth Fifth');
    expect(lines[2]).toBe('[00:10] Alice: Sixth');
  });

  test('should handle window boundaries with speaker changes', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 28, speaker: 'Alice', text: 'Near end' },
      { minutes: 0, seconds: 29, speaker: 'Bob', text: 'At end' },
      { minutes: 0, seconds: 30, speaker: 'Alice', text: 'New window' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('[00:28] Alice: Near end');
    expect(lines[1]).toBe('[00:29] Bob: At end');
    expect(lines[2]).toBe('[00:30] Alice: New window');
  });

  test('should handle pause exactly at 1.5s', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First' },
      { minutes: 0, seconds: 1.5, speaker: 'Alice', text: 'Second' }, // Exactly 1.5s gap
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('[00:00] Alice: First Second');
  });

  test('should handle pause slightly over 1.5s', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'First' },
      { minutes: 0, seconds: 1.6, speaker: 'Alice', text: 'Second' }, // 1.6s gap
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:00] Alice: First');
    expect(lines[1]).toBe('[00:01] Alice: Second');
  });

  test('should handle multiple conditions simultaneously', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 28, speaker: 'Alice', text: 'First' },
      { minutes: 0, seconds: 30, speaker: 'Bob', text: 'Second' },   // New window + speaker change
      { minutes: 0, seconds: 32, speaker: 'Bob', text: 'Third' },    // Long pause (2s)
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('[00:28] Alice: First');
    expect(lines[1]).toBe('[00:30] Bob: Second');
    expect(lines[2]).toBe('[00:32] Bob: Third');
  });

  test('should handle rapid speaker alternation', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 0, speaker: 'Alice', text: 'One' },
      { minutes: 0, seconds: 1, speaker: 'Bob', text: 'Two' },
      { minutes: 0, seconds: 2, speaker: 'Alice', text: 'Three' },
      { minutes: 0, seconds: 3, speaker: 'Bob', text: 'Four' },
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe('[00:00] Alice: One');
    expect(lines[1]).toBe('[00:01] Bob: Two');
    expect(lines[2]).toBe('[00:02] Alice: Three');
    expect(lines[3]).toBe('[00:03] Bob: Four');
  });

  test('should handle segments near but not at window boundary', () => {
    const input = createTestTranscript([
      { minutes: 0, seconds: 28, speaker: 'Alice', text: 'First' },
      { minutes: 0, seconds: 29.5, speaker: 'Alice', text: 'Second' }, // Just before window boundary
      { minutes: 0, seconds: 30.5, speaker: 'Alice', text: 'Third' },  // Just after window boundary
    ]);

    const result = consolidateSegments(input);
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[00:28] Alice: First Second');
    expect(lines[1]).toBe('[00:30] Alice: Third');
  });
}); 