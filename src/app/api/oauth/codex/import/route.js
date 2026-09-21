import { NextResponse } from "next/server";
import { parseCodexBatch } from "@/lib/oauth/codexAuthJson";
import { createProviderConnection } from "@/models";

export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid or empty request body" },
        { status: 400 },
      );
    }

    const payload = body?.content ?? body?.authJson ?? body?.accounts ?? body;
    if (!payload) {
      return NextResponse.json(
        { error: "auth.json or accounts content is required" },
        { status: 400 },
      );
    }

    const { accounts, errors } = parseCodexBatch(payload);

    if (accounts.length === 0) {
      return NextResponse.json(
        {
          error:
            errors.length > 0
              ? errors.join("; ")
              : "No valid Codex accounts found in provided content",
          details: errors,
        },
        { status: 400 },
      );
    }

    const importedConnections = [];
    const importErrors = [...errors];

    for (let i = 0; i < accounts.length; i++) {
      const accountData = accounts[i];
      try {
        const connection = await createProviderConnection({
          ...accountData,
          testStatus: "active",
        });
        importedConnections.push({
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          name: connection.name,
        });
      } catch (err) {
        importErrors.push(
          `Account ${accountData.email || i + 1}: ${err.message}`,
        );
      }
    }

    if (importedConnections.length === 0) {
      return NextResponse.json(
        {
          error: "Failed to create any provider connection",
          details: importErrors,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      count: importedConnections.length,
      connections: importedConnections,
      // Provide single connection object for backward compatibility
      connection: importedConnections[0],
      errors: importErrors.length > 0 ? importErrors : undefined,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
