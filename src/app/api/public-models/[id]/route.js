import {
  getPublicModelRecord,
  updatePublicModelRecord,
  deletePublicModelRecord,
} from "@/lib/localDb";

export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const model = getPublicModelRecord(id);
    if (!model) {
      return Response.json({ error: "Public model not found" }, { status: 404 });
    }
    return Response.json({ success: true, model });
  } catch (error) {
    console.error("Failed to get public model:", error);
    return Response.json(
      { error: error.message || "Failed to get public model" },
      { status: 500 }
    );
  }
}

export async function PUT(req, { params }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const updated = updatePublicModelRecord(id, body);
    if (!updated) {
      return Response.json({ error: "Public model not found" }, { status: 404 });
    }
    return Response.json({ success: true, model: updated });
  } catch (error) {
    console.error("Failed to update public model:", error);
    return Response.json(
      { error: error.message || "Failed to update public model" },
      { status: 500 }
    );
  }
}

export async function DELETE(req, { params }) {
  try {
    const { id } = await params;
    const deleted = deletePublicModelRecord(id);
    if (!deleted) {
      return Response.json({ error: "Public model not found" }, { status: 404 });
    }
    return Response.json({ success: true, deleted: true });
  } catch (error) {
    console.error("Failed to delete public model:", error);
    return Response.json(
      { error: error.message || "Failed to delete public model" },
      { status: 500 }
    );
  }
}
