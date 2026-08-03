import { Injectable } from '@nestjs/common';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';

const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');

@Injectable()
export class StorageService {
  async save(buffer: Buffer, namespace: string, filename: string): Promise<string> {
    const dir = path.join(UPLOADS_ROOT, namespace);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buffer);
    return `${namespace}/${filename}`;
  }

  read(relativePath: string): NodeJS.ReadableStream {
    return createReadStream(path.join(UPLOADS_ROOT, relativePath));
  }

  async delete(relativePath: string): Promise<void> {
    try {
      await fs.unlink(path.join(UPLOADS_ROOT, relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
