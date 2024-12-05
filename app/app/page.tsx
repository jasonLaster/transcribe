import VideoPlayerWithTranscript from '../components/VideoPlayerWithTranscript';


export default function Home() {
  


  
  return (
    <main className="min-h-screen p-4">
      <VideoPlayerWithTranscript
        videoSrc="/video/oklo-q3-investor-call/video.mp4"
      />
    </main>
  );
}

