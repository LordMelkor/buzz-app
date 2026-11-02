# GitHub body playback fixture

`github-body.mp4` repeats the message-gallery sample at its normal playback rate for 30 seconds. The longer clip keeps Play/Pause checks independent of browser actionability delays, without changing playback speed or looping in WebKit. Each player is exercised through its own controls.

Regenerate from the repository root with FFmpeg:

```sh
ffmpeg -stream_loop -1 -i tests/fixtures/message-gallery/assets/sample.mp4 -t 30 -vf 'fps=10,scale=320:180' -an -c:v libx264 -pix_fmt yuv420p -crf 30 -movflags +faststart tests/fixtures/github-body.mp4
```
