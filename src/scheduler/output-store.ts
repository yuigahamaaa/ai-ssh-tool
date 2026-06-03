export const OUTPUT_TAIL_LIMIT = 64 * 1024

export class OutputStore {
  private outputs = new Map<string, { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number }>()

  create(taskId: string): void {
    this.outputs.set(taskId, { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 })
  }

  appendStdout(taskId: string, data: string): void {
    const entry = this.outputs.get(taskId)
    if (!entry) return
    entry.stdout += data
    entry.stdoutBytes += Buffer.byteLength(data)
    if (entry.stdout.length > OUTPUT_TAIL_LIMIT) {
      entry.stdout = entry.stdout.slice(-OUTPUT_TAIL_LIMIT)
    }
  }

  appendStderr(taskId: string, data: string): void {
    const entry = this.outputs.get(taskId)
    if (!entry) return
    entry.stderr += data
    entry.stderrBytes += Buffer.byteLength(data)
    if (entry.stderr.length > OUTPUT_TAIL_LIMIT) {
      entry.stderr = entry.stderr.slice(-OUTPUT_TAIL_LIMIT)
    }
  }

  get(taskId: string): { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number } | undefined {
    return this.outputs.get(taskId)
  }

  remove(taskId: string): void {
    this.outputs.delete(taskId)
  }
}
