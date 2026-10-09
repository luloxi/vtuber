# VTuber · Gally and friends

A browser VTuber. An anime 3D avatar follows you through the webcam and copies your head, eyes, blinks, mouth and arms in real time.

**Live:** https://lulox-vtuber.vercel.app

## Privacy

Everything runs on the client. The webcam stream is processed by MediaPipe inside your browser (WebAssembly + WebGL) and is never uploaded. There are no analytics and no third party requests: the MediaPipe runtime, the face and pose models, the avatars and the hair meshes are all served from this site. Your customizer choice is stored in localStorage only.

## Features

- Head and neck rotation, a little body follow, selfie style mirroring
- Arm and hand tracking with MediaPipe Pose Landmarker (lite) and Hand Landmarker (2 hands). The two models alternate frames. An arm is only shown when its hand is actually detected (or, without the hand model, when the pose is confident). Pose and hand wrists are fused, and the hand model also drives wrist rotation and rough per-finger curls. All landmarks go through a One Euro filter with frame-to-frame jump rejection.
- Hand states with hysteresis:
  - **Not visible, behind you or low confidence:** the arm eases back to rest.
  - **Hands together:** they clasp in front of the body and meet without overlapping.
  - **Hand over your face:** it is raised to the face, but in front of it, never inside the head.
  - **Otherwise:** it follows your arm.
- Body collision: the arms never pass through the character. Capsules and spheres for the torso, neck, head and the other arm are sized per avatar from its own bones and mesh. Every frame, the two-bone IK result is projected out of them, and anything inside the torso resolves to the front. If a pose cannot be cleared, the arm stops at the closest collision-free point on the way back to rest. Press **D** to show the colliders.
- Mouth shapes (aa, ih, ou, ee, oh) from MediaPipe blendshapes (jawOpen, mouthFunnel, mouthPucker, smile, stretch)
- Blinks and winks, eye gaze (iris position), idle breathing, hair physics (VRM spring bones)
- Smoothing so it does not jitter, idle animation when no face is found
- Toggleable camera preview, background presets and a solid green screen for OBS chroma key
- **Load your own .vrm** (button or drag and drop). Models from VRoid Studio (VRM 0.x or 1.0) work. The file stays on your device.
- Press **H** (or use Hide UI) to hide the interface for streaming. Double click to bring it back.

## Customizer

Pick a character, one of 5 hairstyles, 5 hair colours and 5 outfits (saved on the device):

- Characters: Gally (Alita-inspired), Woman, Man, Green alien, Blue alien, Cat, Furry (wolf), Fox (Zootopia-inspired), Bunny (Zootopia-inspired)
- Hairstyles: Bob, Long straight, Short messy, Swept spiky, Fluffy long. Each one is the real hair mesh of a different CC0 VRoid sample, re-bound at runtime to whichever body is loaded (the hair is static, it has no physics).
- Hair colours: Black, Brown, Blonde, Ginger, Silver (hair textures are greyscale and tinted live)
- Outfits: Original, Cyber suit, Green shirt & tie, Officer blue, Red casual. These recolour the base model's own clothes and add a few procedural accessories (tie, badge, glow trims). The cut of the clothes comes from the base model.
- Aliens and animals are the human bases with a skin or fur tint plus procedural three.js parts (ears, tails, muzzles, antennae, whiskers).

The fox and the bunny are original characters that only borrow a general vibe (orange fox with a green shirt and tie, grey bunny in a blue uniform). They use no Disney assets or designs.

## Model sources and licenses

All models are VRoid sample models by pixiv Inc., taken from https://github.com/madjin/vrm-samples (`vroid/beta`). Each file's VRM metadata says `licenseName: CC0`, and VRoid lists these samples as CC0: https://vroid.pixiv.help/hc/en-us/articles/4402614652569

| File in this repo | Source model | License |
| --- | --- | --- |
| `public/models/gally.vrm` | Darkness Shibu (β Ver AvatarSample_1, darkness version) | CC0 ([page](https://vroid.pixiv.help/hc/en-us/articles/360012381793)) |
| `public/models/woman.vrm`, `public/hair/bob.glb` | Sendagaya Shibu (β Ver AvatarSample_1) | CC0 ([page](https://vroid.pixiv.help/hc/en-us/articles/360012381793)) |
| `public/models/man.vrm`, `public/hair/short.glb` | HairSample_Male | CC0 |
| `public/hair/long.glb` | Sendagaya Shino (AvatarSample_1's sister) | CC0 (VRM metadata) |
| `public/hair/swept.glb` | Sakurada Fumiriya (AvatarSample_1's cousin) | CC0 (VRM metadata) |
| `public/hair/fluffy.glb` | Victoria Rubin (β Ver AvatarSample_4) | CC0 ([page](https://vroid.pixiv.help/hc/en-us/articles/360014900233)) |

`tools/build_assets.py` rebuilds the woman, man and hair files from the originals. The derived files are offered under CC0 as well.

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
python3 tools/make_gally.py   # optional, regenerates Gally (needs Pillow + numpy)
python3 tools/build_assets.py # optional, regenerates the woman/man bases and hair meshes
```

Stack: Vite, TypeScript, three.js, @pixiv/three-vrm, @mediapipe/tasks-vision (Face Landmarker float16, Pose Landmarker lite and Hand Landmarker models from Google, Apache 2.0).
