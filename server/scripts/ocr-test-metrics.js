export const cleanOcrTestText = (value) => String(value).replace(/\s/g,'')

// An extra zero or a larger number must not count as a correctly read amount.
export function containsOcrTestField(text, field) {
  const expected = cleanOcrTestText(field)
  const literal = expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const left = /^\d/.test(expected) ? '(?<![\\d.,])' : ''
  const right = /\d$/.test(expected) ? '(?![\\d.,])' : ''
  return new RegExp(left + literal + right).test(cleanOcrTestText(text))
}
