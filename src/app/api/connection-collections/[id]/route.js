import { NextResponse } from "next/server";
import {
  deleteConnectionCollection,
  getConnectionCollectionById,
  replaceCollectionConnections,
  updateConnectionCollection,
} from "@/models";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const collection = await getConnectionCollectionById(id);
    if (!collection) {
      return NextResponse.json(
        { error: "Collection not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ collection });
  } catch (error) {
    console.error("Error fetching connection collection:", error);
    return NextResponse.json(
      { error: "Failed to fetch connection collection" },
      { status: 500 },
    );
  }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (Array.isArray(body.connectionIds)) {
      await replaceCollectionConnections(id, body.connectionIds);
    }

    const hasNameField = Object.prototype.hasOwnProperty.call(body, "name");
    const collection = hasNameField
      ? await updateConnectionCollection(id, { name: body.name })
      : await getConnectionCollectionById(id);

    if (!collection) {
      return NextResponse.json(
        { error: "Collection not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ collection });
  } catch (error) {
    console.error("Error updating connection collection:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update connection collection" },
      { status: 400 },
    );
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteConnectionCollection(id);
    if (!deleted) {
      return NextResponse.json(
        { error: "Collection not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ collection: deleted });
  } catch (error) {
    console.error("Error deleting connection collection:", error);
    return NextResponse.json(
      { error: error.message || "Failed to delete connection collection" },
      { status: 400 },
    );
  }
}
