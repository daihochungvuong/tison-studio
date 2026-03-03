import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.join(__dirname, '..')
const buildDir = path.join(projectDir, 'build')
const logoPath = path.join(projectDir, 'logo.png')

// 确保 build 目录存在
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true })
}

async function generateIcons() {
  console.log('🎨 从 logo.png 生成图标中...')

  if (!fs.existsSync(logoPath)) {
    console.error('❌ 找不到 logo.png，请将 logo.png 放在项目根目录')
    process.exit(1)
  }

  const pngPath = path.join(buildDir, 'icon.png')
  const icoPath = path.join(buildDir, 'icon.ico')

  // 从 logo.png 生成 512x512 PNG 图标
  await sharp(logoPath)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(pngPath)
  console.log('✅ 生成 icon.png (512x512)')

  // 生成多尺寸 PNG 用于 ICO
  const sizes = [16, 32, 48, 64, 128, 256]
  const pngBuffers = await Promise.all(
    sizes.map(size =>
      sharp(logoPath)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  )

  // 转换为 ICO
  const icoBuffer = await pngToIco(pngBuffers)
  fs.writeFileSync(icoPath, icoBuffer)
  console.log('✅ 生成 icon.ico (多尺寸: ' + sizes.join(', ') + ')')

  console.log(`\n📁 图标已保存到: ${buildDir}`)
}

generateIcons().catch(console.error)
