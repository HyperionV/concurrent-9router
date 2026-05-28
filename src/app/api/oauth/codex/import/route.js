import { NextResponse } from "next/server";
import { parseCodexAuthJson } from "@/lib/oauth/codexAuthJson";
import { createProviderConnection } from "@/models";

export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
    }

    const authJson = body?.authJson;
    if (!authJson || typeof authJson !== "string") {
      return NextResponse.json({ error: "auth.json content is required" }, { status: 400 });
    }

    const tokenData = parseCodexAuthJson(authJson);
    const connection = await createProviderConnection({
      ...tokenData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
