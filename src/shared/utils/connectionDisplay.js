const GENERATED_ACCOUNT_NAME_PATTERN = /^Account \d+$/i;

export function getConnectionDisplayLabel(connection = {}) {
  const name = connection.name?.trim();
  const email = connection.email?.trim();

  if (email && (!name || GENERATED_ACCOUNT_NAME_PATTERN.test(name))) {
    return email;
  }

  return name || email || connection.displayName?.trim() || "";
}
