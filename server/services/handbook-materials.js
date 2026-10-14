import { extractText } from './file-parser.js'
import { DOCUMENT_PARSER_VERSION } from './document-materials.js'

export const HANDBOOK_PARSER_VERSION = DOCUMENT_PARSER_VERSION

// Extraction and embedded-image OCR belong to the shared parser.
export async function extractHandbookText(file, options = {}) {
  return extractText(file, options)
}
