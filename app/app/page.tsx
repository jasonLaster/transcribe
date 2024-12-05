import VideoPlayerWithTranscript from '../components/VideoPlayerWithTranscript';


export default function Home() {
  


  
  return (
    <main className="min-h-screen p-4">
      <h1 className="text-2xl font-bold mb-4">Video Player with Synchronized Transcript</h1>
      <VideoPlayerWithTranscript
        videoSrc="/video/oklo-q3-investor-call/video.mp4"
      />
    </main>
  );
}

