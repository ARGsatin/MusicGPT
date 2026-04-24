export interface EnvironmentProvider {
  name: "weather" | "calendar" | "upnp";
  enabled: boolean;
  refresh(): Promise<void>;
}

class NoopProvider implements EnvironmentProvider {
  enabled = false;

  constructor(public readonly name: EnvironmentProvider["name"]) {}

  async refresh(): Promise<void> {
    return;
  }
}

export function createExtensionProviders(): EnvironmentProvider[] {
  return [new NoopProvider("weather"), new NoopProvider("calendar"), new NoopProvider("upnp")];
}
