# VTuber · Gally

A browser VTuber. An anime 3D avatar follows your face through the webcam and copies your head, eyes, blinks and mouth in real time.

**Live:** https://vtuber-luloxi.vercel.app (see the repo description for the current URL)

## Privacy

Everything runs on the client. The webcam stream is processed by MediaPipe inside your browser (WebAssembly + WebGL) and is never uploaded. There are no analytics and no third party requests: the MediaPipe runtime, the face model and the avatar are all served from this site.

## Features

- Head and neck rotation, a little body follow, selfie style mirroring
- Mouth shapes (aa, ih, ou, ee, oh) from MediaPipe blendshapes (jawOpen, mouthFunnel, mouthPucker, smile, stretch)
- Blinks and winks, eye gaze (iris position), idle breathing, hair physics (VRM spring bones)
- Smoothing so it does not jitter, idle animation when no face is found
- Toggleable camera preview, background presets and a solid green screen for OBS chroma key
- **Load your own .vrm** (button or drag and drop). Models from VRoid Studio (VRM 0.x or 1.0) work. The file stays on your device.
- Press **H** (or use Hide UI) to hide the interface for streaming. Double click to bring it back.

## Avatar: Gally (Alita fan homage)

`public/models/gally.vrm` is a personal, non commercial fan homage inspired by Gally / Alita from Yukito Kishiro's manga *Gunnm* (Battle Angel Alita). It is **not** the official movie or anime model and contains no official assets.

It is derived from **"Darkness Shibu" (β Ver AvatarSample_1 by pixiv Inc. / VRoid)**, which is released under **CC0 1.0**:

- License page: https://vroid.pixiv.help/hc/en-us/articles/360012381793-%CE%B2-Ver-AvatarSample-1
- Sample model conditions: https://vroid.pixiv.help/hc/en-us/articles/4402614652569
- File source used: https://github.com/madjin/vrm-samples/blob/master/vroid/beta/Darkness_Shibu.vrm (the VRM metadata also says `licenseName: CC0`)

`tools/make_gally.py` rebuilds it from the original: dark hair, warm brown eyes, dark liner and brows, sleeves removed, gunmetal cyborg arms and legs with panel seams, cyan emissive glow lines and a graphite dress. The modified model is offered under CC0 as well.

## Develop

```bash
npm install          # also copies the MediaPipe wasm into public/mediapipe/wasm
npm run dev          # http://localhost:5173 (camera works on localhost)
npm run build        # static site in dist/
python3 tools/make_gally.py   # optional, regenerates the avatar (needs Pillow + numpy)
```

Stack: Vite, TypeScript, three.js, @pixiv/three-vrm, @mediapipe/tasks-vision (Face Landmarker, float16 model from Google, Apache 2.0).
