import PublicModelsClient from "./PublicModelsClient";

export const metadata = {
  title: "Public Models | 9Router",
  description: "Publicly discoverable model catalog, reasoning effort levels, and integration parameters",
};

export default function PublicModelsPage() {
  return <PublicModelsClient />;
}
