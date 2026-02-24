export interface ConfluencePageLink {
  webui: string;
  self: string;
}

export interface ConfluencePageStorage {
  value: string;
}

export interface ConfluencePageBody {
  storage: ConfluencePageStorage;
}

export interface ConfluencePage {
  id: string;
  title: string;
  body: ConfluencePageBody;
  _links: ConfluencePageLink;
}

export interface ProcessedPage {
  pageUrl: string;
  filename: string;
  text: string;
}

export interface ConfluenceSearchResponse {
  results: any[];
  _links?: {
    next?: string;
  };
}

export interface ConfluencePageResponse {
  results: ConfluencePage[];
  _links?: {
    next?: string;
    base?: string;
  };
}