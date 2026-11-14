import type { Issue, Repository, ValidationReport } from "./schema.js";

export function validateRepository(repository: Repository): ValidationReport {
  const issues: Issue[] = [];
  const components = new Map(
    repository.components.map((item) => [item.id, item]),
  );
  const integrations = new Map(
    repository.integrations.map((item) => [item.id, item]),
  );

  for (const integration of repository.integrations) {
    const file =
      repository.locations[`integrations/${integration.id}`] ??
      `integrations/${integration.id}`;
    for (const componentId of integration.components) {
      const component = components.get(componentId);
      if (!component) {
        issues.push({ file, message: `Unknown component: ${componentId}` });
        continue;
      }
      for (const target of integration.platforms) {
        if (!component.platforms.includes(target)) {
          issues.push({
            file,
            message: `${componentId} does not declare support for ${target}`,
          });
        }
      }
    }
  }

  for (const profile of repository.profiles) {
    const file =
      repository.locations[`profiles/${profile.id}`] ??
      `profiles/${profile.id}`;
    const selected = new Set(profile.components.map((item) => item.component));
    const capabilities = new Set<string>();

    for (const componentId of selected) {
      const component = components.get(componentId);
      if (!component) {
        issues.push({ file, message: `Unknown component: ${componentId}` });
        continue;
      }
      for (const capability of component.provides) capabilities.add(capability);
      for (const target of profile.platforms) {
        if (!component.platforms.includes(target)) {
          issues.push({
            file,
            message: `${componentId} does not declare support for ${target}`,
          });
        }
      }
    }

    for (const integrationId of profile.integrations) {
      const integration = integrations.get(integrationId);
      if (!integration) {
        issues.push({ file, message: `Unknown integration: ${integrationId}` });
        continue;
      }
      let complete = true;
      for (const componentId of integration.components) {
        if (!selected.has(componentId)) {
          complete = false;
          issues.push({
            file,
            message: `${integrationId} requires selected component: ${componentId}`,
          });
        }
        if (!components.has(componentId)) complete = false;
      }
      for (const target of profile.platforms) {
        if (!integration.platforms.includes(target)) {
          complete = false;
          issues.push({
            file,
            message: `${integrationId} does not declare support for ${target}`,
          });
        }
      }
      if (complete) {
        for (const capability of integration.provides)
          capabilities.add(capability);
      }
    }

    for (const capability of profile.requires) {
      if (!capabilities.has(capability)) {
        issues.push({
          file,
          message: `Required capability is not provided: ${capability}`,
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    checked: {
      components: repository.components.length,
      integrations: repository.integrations.length,
      profiles: repository.profiles.length,
    },
    issues,
  };
}
