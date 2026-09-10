declare module "sax" {
  export interface QualifiedAttribute {
    name: string;
    value: string;
    prefix: string;
    local: string;
    uri: string;
  }

  export interface QualifiedTag {
    name: string;
    attributes: Record<string, QualifiedAttribute>;
    prefix: string;
    local: string;
    uri: string;
    isSelfClosing: boolean;
  }

  export interface SaxOptions {
    xmlns?: boolean;
    position?: boolean;
    strictEntities?: boolean;
    maxEntityCount?: number;
    maxEntityDepth?: number;
  }

  export interface SAXParser {
    onopentag: ((tag: QualifiedTag) => void) | undefined;
    onclosetag: ((name: string) => void) | undefined;
    ontext: ((text: string) => void) | undefined;
    oncdata: ((text: string) => void) | undefined;
    ondoctype: ((doctype: string) => void) | undefined;
    onsgmldeclaration: ((declaration: string) => void) | undefined;
    onerror: ((error: Error) => void) | undefined;
    write(chunk: string): SAXParser;
    close(): SAXParser;
  }

  export function parser(strict: boolean, options?: SaxOptions): SAXParser;

  const sax: {
    parser: typeof parser;
  };
  export default sax;
}
