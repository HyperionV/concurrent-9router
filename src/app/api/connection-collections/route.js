import { NextResponse } from "next/server";
import { createConnectionCollection, getConnectionCollections } from "@/models";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const collections = await getConnectionCollections();
    return NextResponse.json({ collections });
  } catch (error) {
    console.error("Error fetching connection collections:", error);
    return NextResponse.json(
      { error: "Failed to fetch connection collections" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const name = String(body?.name || "").trim();
    if (!name) {
      return NextResponse.json(
        { error: "Collection name is required" },
        { status: 400 },
      );
    }
    const collection = await createConnectionCollection({ name });
    return NextResponse.json({ collection }, { status: 201 });
  } catch (error) {
    console.error("Error creating connection collection:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create connection collection" },
      { status: 400 },
    );
  }
}
