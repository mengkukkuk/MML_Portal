import { uploadMimicAsset } from '@/api/mimicAssets'
import { apiErrorMessage } from '@/api/client'
import {
  skinFileKind, skinFileProblem, skinSizeProblem,
} from '@/components/mimic/symbolSkin'

/**
 * A BMP re-encoded as PNG.
 *
 * The server does not store BMP — it is uncompressed, so a screenshot-sized one
 * blows the size limit on its own, and it is the one format here a browser may
 * refuse to draw inside SVG. The browser can decode it, so it is converted here
 * and the PNG is what gets uploaded. Pixels are unchanged; only the container is.
 */
async function bmpToPng(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`${file.name} could not be read as a BMP image.`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close?.()
  const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png') })
  if (!blob) throw new Error(`${file.name} could not be converted to PNG.`)
  return new File([blob], file.name.replace(/\.bmp$/i, '') + '.png', { type: 'image/png' })
}

/**
 * Check, convert if needed, and upload one picture for a symbol skin.
 * Resolves to the stored asset; rejects with a sentence fit to show the admin.
 *
 * The size check runs on what will actually be sent — after BMP conversion, not
 * before — and on the original for formats that go up untouched.
 */
export async function uploadSkin(file) {
  const problem = skinFileProblem(file)
  if (problem) throw new Error(problem)

  const ready = skinFileKind(file) === 'bmp' ? await bmpToPng(file) : file
  const tooBig = skinSizeProblem(ready.name, ready.size)
  if (tooBig) throw new Error(tooBig)

  try {
    return await uploadMimicAsset(ready)
  } catch (e) {
    throw new Error(apiErrorMessage(e, 'Could not upload the image.'))
  }
}
