import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

const IMAGE_EDIT_FILE_FIELDS = ["image", "image[]"];

async function fileToDataUrl(file) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "image/png";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export async function parseCodexImageEditBody(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return {
      error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart body"),
    };
  }

  const images = [];
  for (const fieldName of IMAGE_EDIT_FILE_FIELDS) {
    for (const value of form.getAll(fieldName)) {
      if (value instanceof File && value.size > 0) {
        images.push(await fileToDataUrl(value));
      }
    }
  }

  const maskFile = form.get("mask");
  const mask = (maskFile instanceof File && maskFile.size > 0) ? await fileToDataUrl(maskFile) : null;

  const annotatedImageFile = form.get("annotated_image");
  const annotatedImage = (annotatedImageFile instanceof File && annotatedImageFile.size > 0) ? await fileToDataUrl(annotatedImageFile) : null;

  return {
    body: {
      model: String(form.get("model") || ""),
      prompt: String(form.get("prompt") || ""),
      images,
      mask,
      annotated_image: annotatedImage,
      size: String(form.get("size") || ""),
      quality: String(form.get("quality") || ""),
      background: String(form.get("background") || ""),
      output_format: String(form.get("output_format") || ""),
      image_detail: String(form.get("image_detail") || ""),
    },
  };
}
