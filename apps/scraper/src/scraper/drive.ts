// Google Drive / Docs API calls: inbox listing, file text, folders, moves, backups.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { logInfo, logWarn } from "./log.js";
import { normalizeText } from "./text.js";
import { type DriveDocumentFile, type DriveFileParentsResponse, type DriveListResponse, type GoogleDocument, type GoogleOAuthToken, type StructuralElement } from "./types.js";

export const GOOGLE_DRIVE_FILE_FIELDS = "files(id,name,mimeType,modifiedTime,parents,webViewLink),nextPageToken";

export const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

export const GOOGLE_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "text/csv",
  "text/markdown",
  "text/plain"
]);

export async function listSupportedDriveFilesInFolder(session: GoogleOAuthToken, folderId: string): Promise<DriveDocumentFile[]> {
  const docs: DriveDocumentFile[] = [];
  let pageToken: string | null = null;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("fields", GOOGLE_DRIVE_FILE_FIELDS);
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("orderBy", "modifiedTime");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("q", `'${folderId}' in parents and trashed=false and (mimeType='${GOOGLE_DOC_MIME_TYPE}' or mimeType='text/plain' or mimeType='text/markdown' or mimeType='text/csv' or mimeType='application/json' or mimeType='application/xml')`);
    url.searchParams.set("supportsAllDrives", "true");

    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await googleApiRequest<DriveListResponse>(session, url);
    docs.push(...(response.files ?? []));
    pageToken = response.nextPageToken ?? null;
  } while (pageToken);

  return docs;
}

export async function getGoogleDocument(session: GoogleOAuthToken, documentId: string): Promise<GoogleDocument> {
  const url = new URL(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
  return googleApiRequest<GoogleDocument>(session, url);
}

export async function getDriveFileText(session: GoogleOAuthToken, file: DriveDocumentFile): Promise<string> {
  if (file.mimeType === GOOGLE_DOC_MIME_TYPE) {
    const document = await getGoogleDocument(session, file.id);
    return extractTextFromGoogleDocument(document);
  }

  if (file.mimeType && GOOGLE_TEXT_MIME_TYPES.has(file.mimeType)) {
    return downloadDriveTextFile(session, file.id);
  }

  throw new Error(`Unsupported Drive file type: ${file.mimeType ?? "unknown"}`);
}

export async function downloadDriveTextFile(session: GoogleOAuthToken, fileId: string): Promise<string> {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "text/plain, text/markdown, application/json, application/xml, text/csv;q=0.9, */*;q=0.1"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to download Drive text file (${response.status}): ${text || response.statusText}`);
  }

  return normalizeText(text);
}

export function extractTextFromGoogleDocument(document: GoogleDocument): string {
  return normalizeText(extractStructuralElements(document.body?.content ?? []));
}

export function extractStructuralElements(elements: StructuralElement[]): string {
  const parts: string[] = [];

  for (const element of elements) {
    if (element.paragraph?.elements) {
      const paragraphText = element.paragraph.elements
        .map((paragraphElement) => paragraphElement.textRun?.content ?? paragraphElement.autoText?.content ?? "")
        .join("");
      parts.push(paragraphText);
    }

    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          parts.push(extractStructuralElements(cell.content ?? []));
        }
      }
    }

    if (element.tableOfContents?.content) {
      parts.push(extractStructuralElements(element.tableOfContents.content));
    }
  }

  return parts.join("\n");
}

export async function resolveFailureFolderId(
  session: GoogleOAuthToken,
  watchedFolderId: string,
  configuredFailureFolderId: string | null
): Promise<string> {
  return resolveInboxSubfolderId(session, watchedFolderId, configuredFailureFolderId, "FAILED");
}

export async function resolveArchiveFolderId(
  session: GoogleOAuthToken,
  watchedFolderId: string,
  configuredArchiveFolderId: string | null
): Promise<string> {
  return resolveInboxSubfolderId(session, watchedFolderId, configuredArchiveFolderId, "ARCHIVED");
}

export async function resolveInboxSubfolderId(
  session: GoogleOAuthToken,
  watchedFolderId: string,
  configuredFolderId: string | null,
  suffix: "ARCHIVED" | "BACKUPS" | "FAILED"
): Promise<string> {
  if (configuredFolderId) {
    return configuredFolderId;
  }

  const watchedFolder = await getDriveFileParents(session, watchedFolderId);
  const folderName = `${watchedFolder.name ?? "MEDIUM"}_${suffix}`;

  // Current layout: MEDIUM/MEDIUM_ARCHIVED, MEDIUM/MEDIUM_FAILED, ...
  const nestedFolderId = await findFolderIdByName(session, folderName, watchedFolderId);
  if (nestedFolderId) {
    logInfo(`Drive folder resolved: ${folderName} (${nestedFolderId}) inside inbox`);
    return nestedFolderId;
  }

  // Older layout kept these folders next to the inbox. Keep using them if they
  // still exist so files are never split across two archive folders.
  const parentId = watchedFolder.parents?.[0];
  if (parentId) {
    const siblingFolderId = await findFolderIdByName(session, folderName, parentId);
    if (siblingFolderId) {
      logWarn(`Drive folder resolved: ${folderName} (${siblingFolderId}) next to the inbox (older layout)`);
      return siblingFolderId;
    }
  }

  return createDriveFolder(session, folderName, watchedFolderId);
}

export async function getDriveFileParents(session: GoogleOAuthToken, fileId: string): Promise<DriveFileParentsResponse> {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,parents");
  url.searchParams.set("supportsAllDrives", "true");
  return googleApiRequest<DriveFileParentsResponse>(session, url);
}

export async function findFolderIdByName(session: GoogleOAuthToken, folderName: string, parentId: string): Promise<string | null> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("fields", "files(id)");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("q", `'${parentId}' in parents and name='${escapeDriveQueryValue(folderName)}' and mimeType='${GOOGLE_FOLDER_MIME_TYPE}' and trashed=false`);
  url.searchParams.set("supportsAllDrives", "true");

  const response = await googleApiRequest<{ files?: Array<{ id: string; }>; }>(session, url);
  return response.files?.[0]?.id ?? null;
}

export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function createDriveFolder(session: GoogleOAuthToken, name: string, parentId: string): Promise<string> {
  logInfo(`Creating Drive folder "${name}" under parent ${parentId}.`);
  const response = await googleApiRequest<{ id: string; }>(
    session,
    new URL("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true"),
    {
      method: "POST",
      body: JSON.stringify({
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        name,
        parents: [parentId]
      }),
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return response.id;
}

export async function moveDriveFileToFolder(session: GoogleOAuthToken, fileId: string, folderId: string): Promise<void> {
  const file = await getDriveFileParents(session, fileId);
  const currentParents = (file.parents ?? []).join(",");
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("addParents", folderId);
  if (currentParents) {
    url.searchParams.set("removeParents", currentParents);
  }
  url.searchParams.set("fields", "id,parents");
  url.searchParams.set("supportsAllDrives", "true");

  await googleApiRequest(session, url, {
    method: "PATCH",
    body: JSON.stringify({}),
    headers: {
      "Content-Type": "application/json"
    }
  });
}

export async function findDriveFileByName(session: GoogleOAuthToken, fileName: string, parentId: string): Promise<{ id: string; } | null> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("fields", "files(id)");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("q", `'${parentId}' in parents and name='${escapeDriveQueryValue(fileName)}' and trashed=false`);
  url.searchParams.set("supportsAllDrives", "true");

  const response = await googleApiRequest<{ files?: Array<{ id: string; }>; }>(session, url);
  return response.files?.[0] ?? null;
}

export async function uploadDriveBackupFile(
  session: GoogleOAuthToken,
  folderId: string,
  fileName: string,
  localFilePath: string
): Promise<string> {
  const fileBuffer = await readFile(localFilePath);
  const existingFile = await findDriveFileByName(session, fileName, folderId);

  if (existingFile) {
    logInfo(`Updating existing Drive backup file: ${fileName} (${existingFile.id})`);
    await uploadDriveFileContent(session, existingFile.id, fileBuffer);
    return existingFile.id;
  }

  logInfo(`Creating Drive backup file: ${fileName} in folder ${folderId}`);
  return createDriveBinaryFile(session, folderId, fileName, fileBuffer);
}

export async function uploadDriveFileContent(session: GoogleOAuthToken, fileId: string, fileBuffer: Buffer): Promise<void> {
  const bodyBytes = Uint8Array.from(fileBuffer);
  const url = new URL(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/octet-stream"
    },
    body: new Blob([bodyBytes], { type: "application/octet-stream" })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update Drive backup file (${response.status}): ${text || response.statusText}`);
  }
}

export async function createDriveBinaryFile(
  session: GoogleOAuthToken,
  folderId: string,
  fileName: string,
  fileBuffer: Buffer
): Promise<string> {
  const fileBytes = Uint8Array.from(fileBuffer);
  const boundary = `web-scrapper-${randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId]
  });
  const prefix = Uint8Array.from(Buffer.from(
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n",
    "utf8"
  ));
  const suffix = Uint8Array.from(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

  const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("supportsAllDrives", "true");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body: new Blob([prefix, fileBytes, suffix], { type: `multipart/related; boundary=${boundary}` })
  });

  const payload = await parseJsonResponse<{ error?: { message?: string; }; id?: string; }>(response);
  if (!response.ok || !payload.id) {
    throw new Error(`Failed to create Drive backup file (${response.status}): ${payload.error?.message ?? response.statusText}`);
  }

  return payload.id;
}

export async function googleApiRequest<T = void>(
  session: GoogleOAuthToken,
  url: URL,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.accessToken}`);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await parseJsonResponse<T & { error?: { message?: string; }; }>(response);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? payload.error?.message
      : response.statusText;
    throw new Error(`Google API request failed (${response.status}): ${message ?? "Unknown error"}`);
  }

  return payload;
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? JSON.parse(text) as T : {} as T;
}
