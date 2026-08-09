'use strict'

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const nodeModules = path.join(projectRoot, 'node_modules')

const packages = [
  ['@xmcl/core', '2.16.0'],
  ['@xmcl/installer', '6.3.1'],
  ['@xmcl/file-transfer', '2.1.2'],
  ['@xmcl/unzip', '2.2.0'],
]

function packageDirectory(name) {
  return path.join(nodeModules, ...name.split('/'))
}

function requireFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Required XMCL file is missing: ${path.relative(projectRoot, file)}`)
  }
}

function repairEntrypoint(name, expectedVersion) {
  const directory = packageDirectory(name)
  const manifestPath = path.join(directory, 'package.json')
  const runtimePath = path.join(directory, 'dist', 'index.js')
  const typesPath = path.join(directory, 'dist', 'index.d.ts')

  requireFile(manifestPath)
  requireFile(runtimePath)
  requireFile(typesPath)

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Refusing to repair ${name}@${manifest.version}; expected ${expectedVersion}. ` +
        'Review the package metadata before updating the pinned repair.',
    )
  }

  if (manifest.main !== './index.ts' && manifest.main !== './dist/index.js') {
    throw new Error(`Unexpected ${name} main entrypoint: ${String(manifest.main)}`)
  }

  manifest.main = './dist/index.js'
  manifest.types = './dist/index.d.ts'
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

for (const [name, version] of packages) {
  repairEntrypoint(name, version)
}

const coreDirectory = packageDirectory('@xmcl/core')
fs.writeFileSync(
  path.join(coreDirectory, 'utils.js'),
  `'use strict'\n\nconst { createHash } = require('node:crypto')\nconst { constants, createReadStream } = require('node:fs')\nconst { access } = require('node:fs/promises')\nconst { pipeline } = require('node:stream/promises')\n\nfunction exists(file) {\n  return access(file, constants.F_OK).then(\n    () => true,\n    () => false,\n  )\n}\n\nasync function checksum(target, algorithm) {\n  const hash = createHash(algorithm).setEncoding('hex')\n  try {\n    await pipeline(createReadStream(target), hash)\n  } catch (error) {\n    if (error && error.code === 'ENOENT') return undefined\n    throw error\n  }\n  return hash.read()\n}\n\nasync function validateSha1(target, expected, strict = false) {\n  if (!await exists(target)) return false\n  if (!expected) return !strict\n  return await checksum(target, 'sha1') === expected\n}\n\nfunction isNotNull(value) {\n  return value !== undefined\n}\n\nmodule.exports = { checksum, exists, isNotNull, validateSha1 }\n`,
)
fs.writeFileSync(path.join(coreDirectory, 'utils.d.ts'), "export * from './dist/utils'\n")

console.log('Repaired published XMCL package entrypoints for npm compatibility.')
