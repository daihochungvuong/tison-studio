<p align="center">
  <img src="build/icon.png" width="120" alt="Moyin Creator Logo" />
</p>

<h1 align="center">Moyin Creator 魔因漫创</h1>

<p align="center">
  <strong>🎬 AI-Powered Film & Anime Production Tool · Seedance 2.0 · Script-to-Film Batch Pipeline</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/MemeCalculate/moyin-creator/releases"><img src="https://img.shields.io/github/v/release/MemeCalculate/moyin-creator" alt="Release" /></a>
  <a href="https://github.com/MemeCalculate/moyin-creator/stargazers"><img src="https://img.shields.io/github/stars/MemeCalculate/moyin-creator" alt="Stars" /></a>
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <strong>🇬🇧 English</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#license">License</a> •
  <a href="#contributing">Contributing</a>
</p>

---

## Overview

**Moyin Creator** is a production-grade tool for AI film & anime creators. Five interconnected modules cover the entire pipeline from script to final video:

> **📝 Script → 🎭 Characters → 🌄 Scenes → 🎬 Director → ⭐ S-Class (Seedance 2.0)**

Each stage's output automatically flows into the next — no manual glue required. Supports multiple mainstream AI models, ideal for batch production of short dramas, anime series, trailers, and more.

## Features

### ⭐ S-Class Module — Seedance 2.0 Multimodal Creation
- **Multi-shot merged narrative video generation**: group storyboard scenes into coherent narrative videos
- @Image / @Video / @Audio multimodal references (character refs, scene images, first-frame auto-collection)
- Smart prompt builder: automatic 3-layer fusion (action + cinematography + dialogue lip-sync)
- First-frame grid stitching (N×N strategy)
- Seedance 2.0 constraint auto-validation (≤9 images + ≤3 videos + ≤3 audio, prompt ≤5000 chars)

<img width="578" height="801" alt="S-Class Module 1" src="https://github.com/user-attachments/assets/34b623a3-9be9-4eb5-ae52-a6a9553598ea" />
<img width="584" height="802" alt="S-Class Module 2" src="https://github.com/user-attachments/assets/54c6036b-c545-45c0-a32b-de71b8138484" />
<img width="1602" height="835" alt="S-Class Module 3" src="https://github.com/user-attachments/assets/2b5af973-98c9-4708-bf53-02d11321d86d" />

### 🎬 Script Parsing Engine
- Intelligently breaks scripts into scenes, storyboards, and dialogue
- Auto-detects characters, locations, emotions, and camera language
- Supports multi-episode / multi-act script structures

<img width="1384" height="835" alt="Script Parsing" src="https://github.com/user-attachments/assets/e42266c2-aaeb-4cc3-a734-65516774d495" />

### 🎭 Character Consistency System
- **6-layer identity anchoring**: ensures consistent character appearance across different shots
- Character Bible management
- Character reference image binding

<img width="1384" height="835" alt="Character System" src="https://github.com/user-attachments/assets/763e6ced-43e2-4c7b-a5ea-b13535af5b2e" />

### 🖼️ Scene Generation
- Multi-viewpoint joint image generation
- Auto-conversion from scene descriptions to visual prompts

<img width="1384" height="835" alt="Scene Generation" src="https://github.com/user-attachments/assets/f301d91e-c826-499f-b3dd-79e69613a5e8" />

### 🎞️ Professional Storyboard System
- Cinematic camera parameters (shot size, angle, movement)
- Auto layout and export
- One-click visual style switching (2D / 3D / realistic / stop-motion, etc.)

<img width="1602" height="835" alt="Storyboard System" src="https://github.com/user-attachments/assets/94562cee-3827-4645-82fe-2123fdd86897" />

### 🚀 Batch Production Workflow
- **One-click full pipeline**: script parsing → character/scene generation → storyboard splitting → batch image generation → batch video generation
- Multi-task parallel queue with automatic retry on failure
- Designed for short drama / anime series batch production

### 🤖 Multi-Provider AI Orchestration
- Supports multiple AI image/video generation providers
- API key rotation with load balancing
- Task queue management with automatic retry

## Quick Start

### Requirements

- **Node.js** >= 18
- **npm** >= 9

### Install & Run

```bash
# Clone the repository
git clone https://github.com/MemeCalculate/moyin-creator.git
cd moyin-creator

# Install dependencies
npm install

# Start development mode
npm run dev
```

### Configure API Key

After launching, go to **Settings → API Configuration** and enter your AI provider API key to start using the tool.

### Build

```bash
# Compile + package Windows installer
npm run build

# Compile only (no packaging)
npx electron-vite build
```

## Architecture

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Electron 30 |
| Frontend | React 18 + TypeScript |
| Build Tool | electron-vite (Vite 5) |
| State Management | Zustand 5 |
| UI Components | Radix UI + Tailwind CSS 4 |
| AI Core | `@opencut/ai-core` (prompt compilation, character bible, task polling) |

### Project Structure

```
moyin-creator/
├── electron/              # Electron main process + Preload
│   ├── main.ts            # Main process (storage, file system, protocol handling)
│   └── preload.ts         # Security bridge layer
├── src/
│   ├── components/        # React UI components
│   │   ├── panels/        # Main panels (Script, Character, Scene, Storyboard, Director)
│   │   └── ui/            # Base UI component library
│   ├── stores/            # Zustand global state
│   ├── lib/               # Utilities (AI orchestration, image management, routing)
│   ├── packages/          # Internal packages
│   │   └── ai-core/       # AI core engine
│   └── types/             # TypeScript type definitions
├── build/                 # Build resources (icons)
└── scripts/               # Utility scripts
```

## License

This project uses a **dual licensing** model:

### Open Source — AGPL-3.0

This project is open-sourced under the [GNU AGPL-3.0](LICENSE) license. You are free to use, modify, and distribute it, but any modified code must be open-sourced under the same license.

### Commercial Use

If you need closed-source usage or integration into commercial products, please contact us for a [Commercial License](COMMERCIAL_LICENSE.md).

## Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) for details.

## Contact

- 📧 Email: [memecalculate@gmail.com](mailto:memecalculate@gmail.com)
- 🐙 GitHub: [https://github.com/MemeCalculate/moyin-creator](https://github.com/MemeCalculate/moyin-creator)

---

<p align="center">Made with ❤️ by <a href="https://github.com/MemeCalculate">MemeCalculate</a></p>
