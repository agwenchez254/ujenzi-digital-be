import { BadRequestException, Injectable } from '@nestjs/common';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

@Injectable()
export class StorageService {
  async save(buffer: Buffer, namespace: string, filename: string): Promise<string> {
    const relativePath = `${namespace}/${filename}`;
    const fullPath = this.resolveWithinRoot(relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
    return relativePath;
  }

  read(relativePath: string): NodeJS.ReadableStream {
    return createReadStream(this.resolveWithinRoot(relativePath));
  }

  async delete(relativePath: string): Promise<void> {
    try {
      await fs.unlink(this.resolveWithinRoot(relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  // Prevents path traversal (e.g. "../../etc/passwd") from escaping UPLOADS_ROOT.
  private resolveWithinRoot(relativePath: string): string {
    const fullPath = path.resolve(UPLOADS_ROOT, relativePath);
    if (fullPath !== UPLOADS_ROOT && !fullPath.startsWith(UPLOADS_ROOT + path.sep)) {
      throw new BadRequestException('Invalid storage path');
    }
    return fullPath;
  }
}
