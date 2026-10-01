import { getPublicModelsList } from "@/lib/publicModels";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /api/public/models - Public Model Catalog & Reasoning Interface
 * Returns dynamic model registry with supported reasoning effort levels, context windows, and capabilities.
 */
export async function GET() {
  try {
    const catalog = await getPublicModelsList();

    return Response.json(catalog, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=10, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("Error generating public models list:", error);
    return Response.json(
      {
        error: {
          message: error.message || "Failed to retrieve public models",
          type: "server_error",
        },
      },
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
