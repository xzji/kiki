import fs from "node:fs";
import path from "node:path";

import { getStorageRootDir } from "@/lib/server/storage/paths";

export type StorageRef = {
  adapter: "local-fs" | "remote-r2";
  key: string;
};

export interface StorageAdapter {
  putBlob(key: string, data: string | Buffer): { ref: StorageRef; size: number };
  getBlob(key: string): Buffer;
  signUrl(key: string): string;
}

// CLOUD-MIGRATION: 替换实现时不应改调用方接口。
export class LocalFsStorageAdapter implements StorageAdapter {
  private rootDir = getStorageRootDir();

  private resolveKey(key: string) {
    const resolved = path.resolve(this.rootDir, key);
    const relativePath = path.relative(this.rootDir, resolved);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("非法 storage key");
    }
    return resolved;
  }

  putBlob(key: string, data: string | Buffer) {
    const filePath = this.resolveKey(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    fs.writeFileSync(filePath, buffer);
    return {
      ref: { adapter: "local-fs" as const, key },
      size: buffer.length,
    };
  }

  getBlob(key: string) {
    return fs.readFileSync(this.resolveKey(key));
  }

  signUrl(key: string) {
    return `file://${this.resolveKey(key)}`;
  }
}

export function getStorageAdapter(): StorageAdapter {
  return new LocalFsStorageAdapter();
}
