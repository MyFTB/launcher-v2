import { describe, it, expect, beforeEach } from 'vitest'

// ── Inline copy of Log4jParser (mirrors launch.service.ts) ───────────────────
class Log4jParser {
  private buffer = ''

  feed(rawLine: string): string[] {
    if (this.buffer.length > 0) {
      this.buffer += '\n' + rawLine
      if (rawLine.includes('</log4j:Event>')) {
        const formatted = this.formatEvent(this.buffer)
        this.buffer = ''
        return [formatted]
      }
      return []
    }
    if (rawLine.includes('<log4j:Event')) {
      if (rawLine.includes('</log4j:Event>')) {
        return [this.formatEvent(rawLine)]
      }
      this.buffer = rawLine
      return []
    }
    return [rawLine]
  }

  private formatEvent(xml: string): string {
    const level   = xml.match(/level="([^"]+)"/)?.[1]             ?? 'INFO'
    const thread  = xml.match(/thread="([^"]+)"/)?.[1]            ?? 'main'
    const msMatch = xml.match(/(?:timeMillis|timestamp)="(\d+)"/)
    const msgMatch =
      xml.match(/<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/) ??
      xml.match(/<log4j:Message>([\s\S]*?)<\/log4j:Message>/)
    const message = (msgMatch?.[1] ?? xml).trim()
    let timeStr = ''
    if (msMatch) {
      const d = new Date(parseInt(msMatch[1]))
      timeStr = `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}] `
    }
    return `${timeStr}[${thread}/${level}]: ${message}`
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Log4jParser', () => {
  let parser: Log4jParser
  beforeEach(() => { parser = new Log4jParser() })

  it('passes plain-text lines through unchanged', () => {
    expect(parser.feed('Starting Minecraft')).toEqual(['Starting Minecraft'])
  })

  it('parses a single-line log4j v2 XML event', () => {
    const line = '<log4j:Event xmlns:log4j="http://logging.apache.org/log4j/2.0/events" timeMillis="1706000000000" level="INFO" loggerName="net.minecraft.server.Main" thread="main"><log4j:Message><![CDATA[Starting Minecraft 1.21.8]]></log4j:Message></log4j:Event>'
    const result = parser.feed(line)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/\[main\/INFO\]/)
    expect(result[0]).toContain('Starting Minecraft 1.21.8')
  })

  it('parses a single-line log4j v1 XML event', () => {
    const line = '<log4j:Event logger="net.minecraft.server.Main" timestamp="1706000000000" level="WARN" thread="Server thread"><log4j:Message><![CDATA[Overworld took too long]]></log4j:Message></log4j:Event>'
    const result = parser.feed(line)
    expect(result[0]).toMatch(/\[Server thread\/WARN\]/)
    expect(result[0]).toContain('Overworld took too long')
  })

  it('accumulates and parses a multi-line event', () => {
    const lines = [
      '<log4j:Event level="ERROR" thread="main" timeMillis="1706000000000">',
      '<log4j:Message><![CDATA[Something went wrong]]></log4j:Message>',
      '</log4j:Event>',
    ]
    expect(parser.feed(lines[0])).toEqual([])
    expect(parser.feed(lines[1])).toEqual([])
    const result = parser.feed(lines[2])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/\[main\/ERROR\]/)
    expect(result[0]).toContain('Something went wrong')
  })

  it('formats the timestamp as HH:MM:SS', () => {
    // timeMillis = 0 = 1970-01-01T00:00:00.000Z
    const line = `<log4j:Event level="INFO" thread="main" timeMillis="0"><log4j:Message><![CDATA[test]]></log4j:Message></log4j:Event>`
    const result = parser.feed(line)[0]
    expect(result).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/)
  })

  it('handles events without a timestamp', () => {
    const line = '<log4j:Event level="INFO" thread="main"><log4j:Message><![CDATA[no time]]></log4j:Message></log4j:Event>'
    const result = parser.feed(line)
    expect(result[0]).toBe('[main/INFO]: no time')
  })

  it('handles consecutive events correctly', () => {
    const event = (msg: string) =>
      `<log4j:Event level="INFO" thread="main"><log4j:Message><![CDATA[${msg}]]></log4j:Message></log4j:Event>`
    expect(parser.feed(event('first'))[0]).toContain('first')
    expect(parser.feed(event('second'))[0]).toContain('second')
  })

  it('resets buffer state correctly after multi-line event', () => {
    parser.feed('<log4j:Event level="INFO" thread="t">')
    parser.feed('<log4j:Message><![CDATA[msg]]></log4j:Message>')
    parser.feed('</log4j:Event>')
    // After the event, plain text should pass through normally
    expect(parser.feed('plain line')).toEqual(['plain line'])
  })
})
