import * as fs from 'fs'
import * as path from 'path'

const INPUT_FILE = 'cube.glb' // GLB
// const INPUT_FILE = 'cube.gltf'  // GLTF + BIN file

const COMPONENT_TYPES = {
  5120: { name: 'BYTE', size: 1, array: Int8Array },
  5121: { name: 'UNSIGNED_BYTE', size: 1, array: Uint8Array },
  5122: { name: 'SHORT', size: 2, array: Int16Array },
  5123: { name: 'UNSIGNED_SHORT', size: 2, array: Uint16Array },
  5125: { name: 'UNSIGNED_INT', size: 4, array: Uint32Array },
  5126: { name: 'FLOAT', size: 4, array: Float32Array },
} as const

const TYPE_SIZES = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
} as const

const TRUNCATE_LIMIT = 20

const parseGLB = (glbBuffer: Buffer) => {
  // GLB Header: magic (4), version (4), length (4) = 12 bytes
  const magic = glbBuffer.subarray(0, 4).toString('ascii')
  if (magic !== 'glTF') {
    throw new Error('Invalid GLB file: missing glTF magic')
  }

  const totalLength = glbBuffer.readUInt32LE(8)

  let offset = 12

  // First chunk should be JSON
  const jsonChunkLength = glbBuffer.readUInt32LE(offset)
  const jsonChunkType = glbBuffer.readUInt32LE(offset + 4)

  if (jsonChunkType !== 0x4e4f534a) {
    // "JSON"
    throw new Error('Invalid GLB file: first chunk is not JSON')
  }

  const jsonData = glbBuffer.subarray(offset + 8, offset + 8 + jsonChunkLength)
  const gltfData = JSON.parse(jsonData.toString('utf8'))

  offset += 8 + jsonChunkLength

  // Second chunk should be binary data
  let binaryBuffer: Buffer | null = null
  if (offset < totalLength) {
    const binaryChunkLength = glbBuffer.readUInt32LE(offset)
    const binaryChunkType = glbBuffer.readUInt32LE(offset + 4)

    if (binaryChunkType === 0x004e4942) {
      // "BIN\0"
      binaryBuffer = glbBuffer.subarray(offset + 8, offset + 8 + binaryChunkLength)
    }
  }

  return { gltfData, binaryBuffer }
}

const extractAccessorData = (accessor: any, bufferView: any, binaryBuffer: Buffer) => {
  const componentType = COMPONENT_TYPES[accessor.componentType as keyof typeof COMPONENT_TYPES]
  const typeSize = TYPE_SIZES[accessor.type as keyof typeof TYPE_SIZES]

  if (!componentType) {
    return { error: `Unknown component type: ${accessor.componentType}` }
  }

  const elementSize = componentType.size * typeSize
  const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0)
  const byteLength = accessor.count * elementSize

  // Extract the raw bytes
  const rawBytes = binaryBuffer.subarray(byteOffset, byteOffset + byteLength)

  // Create typed array from the raw bytes - need to properly handle Buffer to ArrayBuffer conversion
  const arrayBuffer = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.length)
  const typedArray = new componentType.array(arrayBuffer)

  // Convert to regular array for JSON serialization
  const values = Array.from(typedArray)

  // Group values by type (e.g., VEC3 -> groups of 3)
  const groupedValues = []
  for (let i = 0; i < values.length; i += typeSize) {
    if (typeSize === 1) {
      groupedValues.push(values[i])
    } else {
      groupedValues.push(values.slice(i, i + typeSize))
    }
  }

  // Truncate if too long
  const wasTruncated = groupedValues.length > TRUNCATE_LIMIT
  const finalValues = wasTruncated ? groupedValues.slice(0, TRUNCATE_LIMIT) : groupedValues

  const result: any = {
    type: accessor.type,
    componentType: componentType.name,
    count: accessor.count,
    min: accessor.min,
    max: accessor.max,
  }

  // Use different field name based on truncation
  if (wasTruncated) {
    result.truncatedValues = finalValues
  } else {
    result.values = finalValues
  }

  return result
}

const extractBinaryData = () => {
  const inputPath = path.join(__dirname, INPUT_FILE)
  let gltfData: any
  let binaryBuffer: Buffer

  if (INPUT_FILE.endsWith('.glb')) {
    // Handle GLB file
    const glbBuffer = fs.readFileSync(inputPath)
    const parsed = parseGLB(glbBuffer)
    gltfData = parsed.gltfData

    if (!parsed.binaryBuffer) {
      throw new Error('GLB file does not contain binary data')
    }
    binaryBuffer = parsed.binaryBuffer
  } else if (INPUT_FILE.endsWith('.gltf')) {
    // Handle GLTF + BIN files
    gltfData = JSON.parse(fs.readFileSync(inputPath, 'utf8'))

    // Find the binary file referenced in the GLTF
    const buffer = gltfData.buffers?.[0]
    if (!buffer?.uri) {
      throw new Error('GLTF file does not reference a binary file')
    }

    const binPath = path.join(path.dirname(inputPath), buffer.uri)
    binaryBuffer = fs.readFileSync(binPath)
  } else {
    throw new Error('Input file must be either .gltf or .glb')
  }

  const result = {
    metadata: {
      generator: gltfData.asset?.generator || 'Unknown',
      version: gltfData.asset?.version || 'Unknown',
      totalBytes: binaryBuffer.length,
      meshCount: gltfData.meshes?.length || 0,
      materialCount: gltfData.materials?.length || 0,
      accessorCount: gltfData.accessors?.length || 0,
      truncationLimit: TRUNCATE_LIMIT,
    },
    materials: (gltfData.materials || []).map((material: any, index: number) => ({
      index,
      name: material.name,
      doubleSided: material.doubleSided,
      baseColor: material.pbrMetallicRoughness?.baseColorFactor,
      metallic: material.pbrMetallicRoughness?.metallicFactor,
      roughness: material.pbrMetallicRoughness?.roughnessFactor,
    })),
    meshes: (gltfData.meshes || []).map((mesh: any, meshIndex: number) => ({
      name: mesh.name,
      primitives: (mesh.primitives || []).map((primitive: any, primIndex: number) => {
        const result: any = {
          materialIndex: primitive.material,
          materialName:
            primitive.material !== undefined && gltfData.materials
              ? gltfData.materials[primitive.material]?.name || 'Unknown Material'
              : 'No Material',
          attributes: {},
        }

        // Extract attribute data (POSITION, NORMAL, TEXCOORD_0, etc.)
        Object.entries(primitive.attributes).forEach(([attributeName, accessorIndex]: [string, any]) => {
          const accessor = gltfData.accessors[accessorIndex]
          const bufferView = gltfData.bufferViews[accessor.bufferView]
          const data = extractAccessorData(accessor, bufferView, binaryBuffer)

          result.attributes[attributeName] = data
        })

        // Extract indices data if present
        if (primitive.indices !== undefined) {
          const accessor = gltfData.accessors[primitive.indices]
          const bufferView = gltfData.bufferViews[accessor.bufferView]
          const data = extractAccessorData(accessor, bufferView, binaryBuffer)

          result.indices = data
        }

        return result
      }),
    })),
  }

  return result
}

// Custom JSON stringify to keep numeric arrays on single lines
const customStringify = (obj: any): string => {
  const jsonString = JSON.stringify(obj, null, 2)

  // Replace arrays of numbers to be on single lines
  return jsonString
    .replace(/\[\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(?:,\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*)*\]/g, match => {
      const numbers = match.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g) || []
      return `[${numbers.join(', ')}]`
    })
    .replace(/\[\s*(\[[\d\s,.-]+\])(?:\s*,\s*(\[[\d\s,.-]+\]))*\s*\]/g, match => {
      const arrays = match.match(/\[[\d\s,.-]+\]/g) || []
      const compactArrays = arrays.map(arr =>
        arr.replace(
          /\[\s*([\d\s,.-]+)\s*\]/,
          (m, nums) => `[${nums.replace(/\s+/g, ' ').replace(/,\s+/g, ', ').trim()}]`,
        ),
      )
      return `[${compactArrays.join(', ')}]`
    })
}

// Extract the data
const extractedData = extractBinaryData()

// Write to JSON file
const outputPath = path.join(__dirname, `${INPUT_FILE}.json`)
fs.writeFileSync(outputPath, customStringify(extractedData))

console.log(`✅ Extracted binary data from ${INPUT_FILE} to ${path.basename(outputPath)}`)
console.log(`📊 Total bytes processed: ${extractedData.metadata.totalBytes}`)
console.log(`🎯 Meshes mapped: ${extractedData.meshes.length}`)
console.log(`🎨 Materials: ${extractedData.materials.length}`)
console.log(`✂️  Arrays truncated at ${TRUNCATE_LIMIT} items`)
