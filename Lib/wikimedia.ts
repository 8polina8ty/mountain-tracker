type WikidataEntityResponse = {
  entities?: Record<
    string,
    {
      claims?: {
        P18?: Array<{
          mainsnak?: {
            datavalue?: {
              value?: string;
            };
          };
        }>;
      };
    }
  >;
};

type CommonsImageResponse = {
  query?: {
    pages?: Record<
      string,
      {
        imageinfo?: Array<{
          url?: string;
          thumburl?: string;
          descriptionurl?: string;
          extmetadata?: {
            Artist?: {
              value?: string;
            };
            LicenseShortName?: {
              value?: string;
            };
            Credit?: {
              value?: string;
            };
          };
        }>;
      }
    >;
  };
};

export type WikimediaMountainImage = {
  url: string;
  originalUrl: string | null;
  descriptionUrl: string | null;
  artist: string | null;
  license: string | null;
  credit: string | null;
};

export async function getMountainImageFromWikidata(
  wikidataId: string | null,
): Promise<WikimediaMountainImage | null> {
  if (!wikidataId) {
    return null;
  }

  try {
    const wikidataUrl = new URL(
      "https://www.wikidata.org/w/api.php",
    );

    wikidataUrl.searchParams.set("action", "wbgetentities");
    wikidataUrl.searchParams.set("format", "json");
    wikidataUrl.searchParams.set("ids", wikidataId);
    wikidataUrl.searchParams.set("props", "claims");
    wikidataUrl.searchParams.set("origin", "*");

    const wikidataResponse = await fetch(wikidataUrl, {
      next: {
        revalidate: 86400,
      },
    });

    if (!wikidataResponse.ok) {
      throw new Error(
        `Wikidata returned ${wikidataResponse.status}`,
      );
    }

    const wikidataData =
      (await wikidataResponse.json()) as WikidataEntityResponse;

    const filename =
      wikidataData.entities?.[wikidataId]?.claims?.P18?.[0]
        ?.mainsnak?.datavalue?.value;

    if (!filename) {
      return null;
    }

    const commonsUrl = new URL(
      "https://commons.wikimedia.org/w/api.php",
    );

    commonsUrl.searchParams.set("action", "query");
    commonsUrl.searchParams.set("format", "json");
    commonsUrl.searchParams.set("prop", "imageinfo");
    commonsUrl.searchParams.set(
      "titles",
      `File:${filename}`,
    );
    commonsUrl.searchParams.set(
      "iiprop",
      "url|extmetadata",
    );
    commonsUrl.searchParams.set("iiurlwidth", "1600");
    commonsUrl.searchParams.set(
      "iiextmetadatafilter",
      "Artist|LicenseShortName|Credit",
    );
    commonsUrl.searchParams.set("origin", "*");

    const commonsResponse = await fetch(commonsUrl, {
      next: {
        revalidate: 86400,
      },
    });

    if (!commonsResponse.ok) {
      throw new Error(
        `Wikimedia Commons returned ${commonsResponse.status}`,
      );
    }

    const commonsData =
      (await commonsResponse.json()) as CommonsImageResponse;

    const page = Object.values(
      commonsData.query?.pages ?? {},
    )[0];

    const imageInfo = page?.imageinfo?.[0];

    if (!imageInfo?.thumburl && !imageInfo?.url) {
      return null;
    }

    return {
      url: imageInfo.thumburl ?? imageInfo.url!,
      originalUrl: imageInfo.url ?? null,
      descriptionUrl: imageInfo.descriptionurl ?? null,
      artist:
        imageInfo.extmetadata?.Artist?.value ?? null,
      license:
        imageInfo.extmetadata?.LicenseShortName?.value ??
        null,
      credit:
        imageInfo.extmetadata?.Credit?.value ?? null,
    };
  } catch (error) {
    console.error(
      "Ошибка загрузки изображения Wikimedia:",
      error,
    );

    return null;
  }
}