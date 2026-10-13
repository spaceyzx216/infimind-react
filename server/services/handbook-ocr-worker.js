// Child process entry, not a server route. It writes only the parsed result.
import { readFile, writeFile } from 'node:fs/promises'
import { extractText } from './file-parser.js'

const [source, output, originalname] = process.argv.slice(2)
if (!source || !output) throw new Error('OCR child requires source and result paths')
const parsed = await extractText({ buffer: await readFile(source), originalname, mimetype: 'image/png' })
await writeFile(output, JSON.stringify(parsed))
