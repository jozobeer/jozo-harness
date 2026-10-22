const IMAGE_SRC = /^https?:\/\/\S+$/i

/** The src a markdown image may take; only http(s) is drawn, so a data: URL stays text. */
export const imageSrcOf = (url: string): string | undefined =>
  IMAGE_SRC.test(url) ? url : undefined
