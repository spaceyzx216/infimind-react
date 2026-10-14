import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser'

const namespaces = new Map([
  ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', ''],
  ['http://schemas.openxmlformats.org/presentationml/2006/main', 'p'],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', 'a'],
  ['http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'xdr'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r'],
  ['http://schemas.openxmlformats.org/package/2006/relationships', ''],
  ['http://schemas.openxmlformats.org/package/2006/content-types', ''],
])
const options = { ignoreAttributes:false, preserveOrder:true, parseTagValue:false, parseAttributeValue:false,
  trimValues:false, cdataPropName:'#cdata', commentPropName:'#comment' }
const parser = new XMLParser(options), builder = new XMLBuilder(options)

// Resolve scoped namespace declarations. Never strip an arbitrary prefix by name:
// only known Office namespace URIs are rewritten, and cell text is untouched.
export function normalizeOfficeNamespaces(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('文档包含不支持的XML实体声明')
  const declarations = [...xml.matchAll(/\bxmlns(?::([\w.-]+))?\s*=\s*["']([^"']+)["']/g)]
  if (!declarations.some(([,prefix = '',uri]) => namespaces.has(uri) && namespaces.get(uri) !== prefix)) return xml
  const valid = XMLValidator.validate(xml)
  if (valid !== true) throw new Error(`Office XML损坏：${valid.err.msg}`)
  let changed = false
  const rename = (name, scope, attribute = false) => {
    const colon = name.indexOf(':')
    const prefix = colon < 0 ? '' : name.slice(0,colon), local = colon < 0 ? name : name.slice(colon+1)
    const uri = attribute && !prefix ? null : scope[prefix]
    const canonical = namespaces.get(uri)
    return { name:canonical === undefined ? name : canonical ? `${canonical}:${local}` : local, uri, canonical }
  }
  const walk = (nodes, inherited = {}, inheritedDefault = '', depth = 0) => {
    if (depth > 128) throw new Error('Office XML层级过深，请简化材料')
    return nodes.map((node) => {
      const attrs = {...node[':@']}, scope = Object.assign(Object.create(null),inherited)
      for(const [key,value] of Object.entries(attrs)) {
        if (key === '@_xmlns') scope[''] = value
        else if (key.startsWith('@_xmlns:')) scope[key.slice(8)] = value
      }
      let outputDefault = attrs['@_xmlns'] ?? inheritedDefault
      for(const key of Object.keys(attrs)) {
        if (!key.startsWith('@_') || key.startsWith('@_xmlns')) continue
        const result = rename(key.slice(2),scope,true)
        if (result.name !== key.slice(2)) {
          attrs[`@_${result.name}`] = attrs[key]; delete attrs[key]; changed = true
          if(result.canonical) attrs[`@_xmlns:${result.canonical}`] = result.uri
        }
      }
      const output = Object.create(null)
      for(const [key,value] of Object.entries(node)) {
        if (key === ':@') continue
        if (/^[#?]/.test(key)) { output[key] = value; continue }
        const result = rename(key,scope)
        if(result.name !== key) {
          changed = true
          if(result.canonical === '' && result.uri !== outputDefault) { attrs['@_xmlns'] = result.uri; outputDefault = result.uri }
          else if(result.canonical && scope[result.canonical] !== result.uri) attrs[`@_xmlns:${result.canonical}`] = result.uri
        }
        output[result.name] = Array.isArray(value) ? walk(value,scope,outputDefault,depth+1) : value
      }
      if(Object.keys(attrs).length) output[':@'] = attrs
      return output
    })
  }
  const normalized = walk(parser.parse(xml))
  return changed ? builder.build(normalized) : xml
}
