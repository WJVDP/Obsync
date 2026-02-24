import * as Y from "yjs";

export interface CrdtSnapshot {
  updateBase64: string;
  stateVectorBase64: string;
}

export class YjsMarkdownEngine {
  private readonly docs = new Map<string, Y.Doc>();

  getOrCreate(filePath: string): Y.Doc {
    const existing = this.docs.get(filePath);
    if (existing) {
      return existing;
    }

    const doc = new Y.Doc();
    this.docs.set(filePath, doc);
    return doc;
  }

  applyText(filePath: string, text: string): CrdtSnapshot {
    const doc = this.getOrCreate(filePath);
    const yText = doc.getText("content");
    yText.delete(0, yText.length);
    yText.insert(0, text);

    return {
      updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
      stateVectorBase64: Buffer.from(Y.encodeStateVector(doc)).toString("base64")
    };
  }

  mergeRemoteUpdate(filePath: string, remoteUpdateBase64: string): string {
    const doc = this.getOrCreate(filePath);
    const update = Buffer.from(remoteUpdateBase64, "base64");
    Y.applyUpdate(doc, update);
    return doc.getText("content").toString();
  }
}
