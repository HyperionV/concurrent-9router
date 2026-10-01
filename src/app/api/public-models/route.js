import { listPublicModelRecords, createPublicModelRecord } from "@/lib/localDb";

export async function GET() {
  try {
    const models = listPublicModelRecords(false); // list all (both active & inactive)
    return Response.json({ success: true, models });
  } catch (error) {
    console.error("Failed to list public models:", error);
    return Response.json(
      { error: error.message || "Failed to list public models" },
      { status: 500 }
    );
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body?.name?.trim() || (!body?.targetModel?.trim() && !body?.target_model?.trim())) {
      return Response.json(
        { error: "Model name and target model ID are required." },
        { status: 400 }
      );
    }

    const created = createPublicModelRecord(body);
    return Response.json({ success: true, model: created }, { status: 201 });
  } catch (error) {
    console.error("Failed to create public model:", error);
    return Response.json(
      { error: error.message || "Failed to create public model" },
      { status: 500 }
    );
  }
}
