"use client";
import React, { useState, useRef } from 'react';
import { formatTime } from '../utils/formatTime';
import { parseTranscript } from '../utils/parseTranscript';
import {  useEffect } from 'react';
import { TranscriptEntry } from '@/data/transcript';

interface Props {
  videoSrc: string;
}

export default function VideoPlayerWithTranscript({ videoSrc }: Props) {
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);


  useEffect(() => {
    fetch(`${videoSrc.replace('/video.mp4', '')}/transcript.txt`)
      .then(response => response.text())
      .then(text => {
        const parsed = parseTranscript(text);
        console.log('Parsed transcript:', parsed);
        setTranscript(parsed);
      });
  }, [videoSrc]);


  // Update current time when video plays
  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  // Handle clicking on transcript
  const handleTranscriptClick = (start: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = start;
      setCurrentTime(start);
      videoRef.current.play();
    }
  };

  // Jump to current segment
  const jumpToCurrentSegment = () => {
    const currentSegment = transcript.find((segment, index) => {
      const nextSegment = transcript[index + 1];
      return currentTime >= segment.time && (!nextSegment || currentTime < nextSegment.time);
    });

    if (currentSegment && transcriptRef.current) {
      const segmentElement = document.getElementById(`segment-${currentSegment.time}`);
      if (segmentElement) {
        segmentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <video
          ref={videoRef}
          onTimeUpdate={handleTimeUpdate}
          controls
          className="w-full"
          src={videoSrc}
        />
      </div>
      <div className="flex flex-col h-[600px] border rounded">
        <div className="p-2 border-b bg-gray-50 sticky top-0">
          <button
            onClick={jumpToCurrentSegment}
            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l-4 4m0 0l-4-4m4 4V3m0 0v11" />
            </svg>
            Jump to Current
          </button>
        </div>
        <div 
          ref={transcriptRef}
          className="flex-1 overflow-y-auto p-4"
        >
          {transcript.map((segment, index) => (
            <div
              key={`${segment.time}-${index}`}
              id={`segment-${segment.time}`}
              onClick={() => handleTranscriptClick(segment.time)}
              className={`mb-2 p-2 rounded cursor-pointer hover:bg-gray-100 ${
                currentTime >= segment.time && 
                currentTime < (transcript[transcript.indexOf(segment) + 1]?.time || Infinity)
                  ? 'bg-blue-100'
                  : ''
              }`}
            >
              <span className="text-gray-500 text-sm">
                {formatTime(segment.time)}
              </span>
              <p>{segment.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

