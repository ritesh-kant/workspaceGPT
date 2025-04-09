export interface ConfluencePageLink {
  webui: string;
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
  totalSize: number;
}

export interface ConfluencePageResponse {
  results: ConfluencePage[];
  size: number;
  _links: {
    next?: string;
  };
}