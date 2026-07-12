const encoder = new TextEncoder();

export type StoredData = string | Uint8Array;

export interface SessionFileStore {
  write(path: string, data: StoredData): Promise<void>;
  append(path: string, data: StoredData): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  readBlob(path: string): Promise<Blob>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  remove(prefix: string): Promise<void>;
}

export function toBytes(data: StoredData): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

function normalizedParts(path: string): string[] {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Unsafe storage path: ${path}`);
  }
  return parts;
}

export class MemoryFileStore implements SessionFileStore {
  readonly files = new Map<string, Uint8Array>();

  async write(path: string, data: StoredData): Promise<void> {
    this.files.set(normalizedParts(path).join("/"), toBytes(data).slice());
  }

  async append(path: string, data: StoredData): Promise<void> {
    const key = normalizedParts(path).join("/");
    const previous = this.files.get(key) ?? new Uint8Array();
    const next = toBytes(data);
    const combined = new Uint8Array(previous.byteLength + next.byteLength);
    combined.set(previous);
    combined.set(next, previous.byteLength);
    this.files.set(key, combined);
  }

  async read(path: string): Promise<Uint8Array> {
    const value = this.files.get(normalizedParts(path).join("/"));
    if (!value) throw new Error(`Storage object not found: ${path}`);
    return value.slice();
  }

  async readBlob(path: string): Promise<Blob> {
    const value = this.files.get(normalizedParts(path).join("/"));
    if (!value) throw new Error(`Storage object not found: ${path}`);
    return new Blob([value.slice() as BlobPart]);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalizedParts(path).join("/"));
  }

  async list(prefix: string): Promise<string[]> {
    const key = normalizedParts(prefix).join("/");
    const directoryPrefix = key ? `${key}/` : "";
    return [...this.files.keys()]
      .filter((path) => path === key || path.startsWith(directoryPrefix))
      .sort();
  }

  async remove(prefix: string): Promise<void> {
    for (const path of await this.list(prefix)) this.files.delete(path);
  }
}

interface StorageManagerWithDirectory extends StorageManager {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
}

export class OpfsFileStore implements SessionFileStore {
  private readonly rootPromise: Promise<FileSystemDirectoryHandle>;

  constructor(root?: FileSystemDirectoryHandle) {
    if (root) {
      this.rootPromise = Promise.resolve(root);
      return;
    }

    const manager = navigator.storage as StorageManagerWithDirectory;
    if (typeof manager?.getDirectory !== "function") {
      throw new Error("OPFS is unavailable in this browser context");
    }
    this.rootPromise = manager.getDirectory();
  }

  async write(path: string, data: StoredData): Promise<void> {
    const file = await this.getFileHandle(path, true);
    const writer = await file.createWritable();
    try {
      await writer.write(toBytes(data) as unknown as FileSystemWriteChunkType);
    } finally {
      await writer.close();
    }
  }

  async append(path: string, data: StoredData): Promise<void> {
    const file = await this.getFileHandle(path, true);
    const current = await file.getFile();
    const writer = await file.createWritable({ keepExistingData: true });
    try {
      await writer.seek(current.size);
      await writer.write(toBytes(data) as unknown as FileSystemWriteChunkType);
    } finally {
      await writer.close();
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const file = await (await this.getFileHandle(path, false)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readBlob(path: string): Promise<Blob> {
    return (await this.getFileHandle(path, false)).getFile();
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.getFileHandle(path, false);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return false;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const parts = normalizedParts(prefix);
    const root = await this.rootPromise;
    let directory = root;
    const baseParts: string[] = [];

    try {
      for (const part of parts) {
        directory = await directory.getDirectoryHandle(part);
        baseParts.push(part);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        if (parts.length === 0) return [];
        const filePath = parts.join("/");
        return (await this.exists(filePath)) ? [filePath] : [];
      }
      throw error;
    }

    const output: string[] = [];
    await this.walk(directory, baseParts, output);
    return output.sort();
  }

  async remove(prefix: string): Promise<void> {
    const parts = normalizedParts(prefix);
    if (parts.length === 0) throw new Error("Refusing to remove the OPFS root");
    const leaf = parts.pop()!;
    const parent = await this.getDirectory(parts, false);
    try {
      await parent.removeEntry(leaf, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
  }

  private async getDirectory(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let directory = await this.rootPromise;
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part, { create });
    }
    return directory;
  }

  private async getFileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const parts = normalizedParts(path);
    const filename = parts.pop();
    if (!filename) throw new Error("A file path is required");
    const directory = await this.getDirectory(parts, create);
    return directory.getFileHandle(filename, { create });
  }

  private async walk(
    directory: FileSystemDirectoryHandle,
    parts: string[],
    output: string[],
  ): Promise<void> {
    const iterable = directory as FileSystemDirectoryHandle & AsyncIterable<[string, FileSystemHandle]>;
    for await (const [name, handle] of iterable) {
      const next = [...parts, name];
      if (handle.kind === "file") output.push(next.join("/"));
      else await this.walk(handle as FileSystemDirectoryHandle, next, output);
    }
  }
}
