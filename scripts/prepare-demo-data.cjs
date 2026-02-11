/**
 * prepare-demo-data.js
 * 
 * One-time script to extract and curate demo project data from the user's
 * current data directory. Outputs to demo-data/ in the project root.
 * 
 * Usage: node scripts/prepare-demo-data.js
 */

const fs = require('fs')
const path = require('path')

// ==================== Config ====================
const SOURCE_BASE = 'G:\\漫剧数据'
const DEMO_PROJECT_ID = 'a4bbe260-0127-49c7-9230-e766402663c7'
const KEEP_CHAR_ID = 'char_1769786505036_5k14uad'         // 沈星晴
const REPLACE_CHAR_ID = 'char_1770385146984_4qeuvp3'      // 沈星晴2 → replace with 沈星晴

const OUTPUT_ROOT = path.join(__dirname, '..', 'demo-data')
const OUTPUT_PROJECTS = path.join(OUTPUT_ROOT, 'projects')
const OUTPUT_MEDIA = path.join(OUTPUT_ROOT, 'media')

const SRC_PROJECTS = path.join(SOURCE_BASE, 'projects')
const SRC_MEDIA = path.join(SOURCE_BASE, 'media')
const SRC_PROJECT_DIR = path.join(SRC_PROJECTS, '_p', DEMO_PROJECT_ID)

// ==================== Helpers ====================
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJSON(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(raw)
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8')
  const size = fs.statSync(filePath).size
  console.log(`  ✓ ${path.relative(OUTPUT_ROOT, filePath)} (${(size / 1024).toFixed(1)}KB)`)
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest))
  fs.copyFileSync(src, dest)
  const size = fs.statSync(dest).size
  console.log(`  ✓ ${path.relative(OUTPUT_ROOT, dest)} (${(size / 1024).toFixed(1)}KB)`)
}

// Deep replace all occurrences of a string in a JSON-serializable object
function deepReplace(obj, search, replace) {
  const json = JSON.stringify(obj)
  return JSON.parse(json.replaceAll(search, replace))
}

// ==================== 1. Project Store ====================
function prepareProjectStore() {
  console.log('\n[1] moyin-project-store.json')
  const data = {
    state: {
      projects: [{
        id: DEMO_PROJECT_ID,
        name: '灌篮少女（演示）',
        createdAt: 1770385000000,
        updatedAt: Date.now(),
      }],
      activeProjectId: DEMO_PROJECT_ID,
    },
    version: 0,
  }
  writeJSON(path.join(OUTPUT_PROJECTS, 'moyin-project-store.json'), data)
}

// ==================== 2. Script ====================
function prepareScript() {
  console.log('\n[2] script.json')
  const src = path.join(SRC_PROJECT_DIR, 'script.json')
  const data = readJSON(src)
  // Ensure activeProjectId matches
  if (data.state) data.state.activeProjectId = DEMO_PROJECT_ID
  writeJSON(path.join(OUTPUT_PROJECTS, '_p', DEMO_PROJECT_ID, 'script.json'), data)
}

// ==================== 3. Director ====================
function prepareDirector() {
  console.log('\n[3] director.json')
  const src = path.join(SRC_PROJECT_DIR, 'director.json')
  let data = readJSON(src)

  // Replace all 沈星晴2 char IDs with 沈星晴
  data = deepReplace(data, REPLACE_CHAR_ID, KEEP_CHAR_ID)

  const pd = (data.state || data).projectData
  if (pd && pd.splitScenes) {
    for (const scene of pd.splitScenes) {
      // Strip video data from all scenes
      if (scene.videoUrl) scene.videoUrl = ''
      if (scene.videoStatus === 'completed') scene.videoStatus = 'idle'
      scene.videoProgress = 0
      scene.videoMediaId = ''
    }
  }

  // Ensure activeProjectId
  if (data.state) data.state.activeProjectId = DEMO_PROJECT_ID

  writeJSON(path.join(OUTPUT_PROJECTS, '_p', DEMO_PROJECT_ID, 'director.json'), data)
}

// ==================== 4. Characters (per-project) ====================
function prepareCharacters() {
  console.log('\n[4] characters.json (per-project)')
  // Read the global character library to get 沈星晴's full data
  const libSrc = path.join(SRC_PROJECTS, 'moyin-character-library.json')
  const libData = readJSON(libSrc)
  const chars = (libData.state || libData).characters || []
  const shenxingqing = chars.find(c => c.id === KEEP_CHAR_ID)

  if (!shenxingqing) {
    console.error('  ✗ Character not found:', KEEP_CHAR_ID)
    return
  }

  // Update projectId to demo project
  const char = { ...shenxingqing, projectId: DEMO_PROJECT_ID }

  const data = {
    state: {
      characters: [char],
      currentFolderId: null,
      folders: [],
    },
    version: 0,
  }
  writeJSON(path.join(OUTPUT_PROJECTS, '_p', DEMO_PROJECT_ID, 'characters.json'), data)
}

// ==================== 5. Scenes ====================
function prepareScenes() {
  console.log('\n[5] scenes.json')
  const src = path.join(SRC_PROJECT_DIR, 'scenes.json')
  const data = readJSON(src)
  if (data.state) data.state.activeProjectId = DEMO_PROJECT_ID
  writeJSON(path.join(OUTPUT_PROJECTS, '_p', DEMO_PROJECT_ID, 'scenes.json'), data)
}

// ==================== 6. Media ====================
function prepareMedia() {
  console.log('\n[6] media.json')
  const src = path.join(SRC_PROJECT_DIR, 'media.json')
  const data = readJSON(src)
  const state = data.state || data

  // Remove video media files
  if (state.mediaFiles) {
    const before = state.mediaFiles.length
    state.mediaFiles = state.mediaFiles.filter(f => f.type !== 'video')
    console.log(`  Removed ${before - state.mediaFiles.length} video entries`)
  }

  writeJSON(path.join(OUTPUT_PROJECTS, '_p', DEMO_PROJECT_ID, 'media.json'), data)
}

// ==================== 7. S-Class ====================
function prepareSclass() {
  console.log('\n[7] sclass.json')
  const src = path.join(SRC_PROJECT_DIR, 'sclass.json')
  const data = readJSON(src)
  const pd = (data.state || data).projectData

  if (pd && pd.shotGroups) {
    for (const group of pd.shotGroups) {
      if (group.videoRefs) {
        // Strip base64 video data from videoRefs but keep the structure
        group.videoRefs = group.videoRefs.map(ref => ({
          ...ref,
          localUrl: '',  // Remove the massive base64 data
        }))
        console.log(`  Stripped video data from group "${group.name}" (${group.videoRefs.length} refs)`)
      }
    }
  }

  if (data.state) data.state.activeProjectId = DEMO_PROJECT_ID

  writeJSON(path.join(OUTPUT_PROJECTS, '_p', DEMO_PROJECT_ID, 'sclass.json'), data)
}

// ==================== 8. Character Library (global/legacy) ====================
function prepareCharacterLibrary() {
  console.log('\n[8] moyin-character-library.json (global)')
  const libSrc = path.join(SRC_PROJECTS, 'moyin-character-library.json')
  const libData = readJSON(libSrc)
  const chars = (libData.state || libData).characters || []
  const shenxingqing = chars.find(c => c.id === KEEP_CHAR_ID)

  if (!shenxingqing) {
    console.error('  ✗ Character not found:', KEEP_CHAR_ID)
    return
  }

  const char = { ...shenxingqing, projectId: DEMO_PROJECT_ID }

  const data = {
    state: {
      characters: [char],
      currentFolderId: null,
      folders: [],
    },
    version: 0,
  }
  writeJSON(path.join(OUTPUT_PROJECTS, 'moyin-character-library.json'), data)
}

// ==================== 9. Shared (empty) ====================
function prepareShared() {
  console.log('\n[9] _shared/ (empty stores)')
  const emptyStore = { state: { characters: [], currentFolderId: null, folders: [] }, version: 0 }
  const emptySceneStore = { state: { scenes: [], currentFolderId: null, folders: [] }, version: 0 }
  const emptyMediaStore = { state: { mediaFiles: [], folders: [], currentFolderId: null }, version: 0 }

  writeJSON(path.join(OUTPUT_PROJECTS, '_shared', 'characters.json'), emptyStore)
  writeJSON(path.join(OUTPUT_PROJECTS, '_shared', 'scenes.json'), emptySceneStore)
  writeJSON(path.join(OUTPUT_PROJECTS, '_shared', 'media.json'), emptyMediaStore)
}

// ==================== 10. Media Files (images) ====================
function prepareMediaFiles() {
  console.log('\n[10] Media image files')

  const files = [
    // Character reference image
    'characters/1769786550310_p6r8e5.png',
    // Scene reference images
    'scenes/1770391759169_46aamo.png',
    'scenes/1770391759193_nylbof.png',
    'scenes/1770391759220_dtiues.png',
    'scenes/1770391759253_s4c6ry.png',
  ]

  for (const file of files) {
    const src = path.join(SRC_MEDIA, file)
    const dest = path.join(OUTPUT_MEDIA, file)
    if (fs.existsSync(src)) {
      copyFile(src, dest)
    } else {
      console.error(`  ✗ Missing: ${src}`)
    }
  }
}

// ==================== Main ====================
function main() {
  console.log('=== Preparing Demo Data ===')
  console.log(`Source: ${SOURCE_BASE}`)
  console.log(`Output: ${OUTPUT_ROOT}`)

  // Clean output directory
  if (fs.existsSync(OUTPUT_ROOT)) {
    fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true })
    console.log('Cleaned previous output.')
  }

  prepareProjectStore()
  prepareScript()
  prepareDirector()
  prepareCharacters()
  prepareScenes()
  prepareMedia()
  prepareSclass()
  prepareCharacterLibrary()
  prepareShared()
  prepareMediaFiles()

  // Summary
  console.log('\n=== Done ===')
  const totalSize = getDirSize(OUTPUT_ROOT)
  console.log(`Total output: ${(totalSize / 1024 / 1024).toFixed(2)} MB`)
}

function getDirSize(dirPath) {
  let total = 0
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += getDirSize(full)
    } else {
      total += fs.statSync(full).size
    }
  }
  return total
}

main()
