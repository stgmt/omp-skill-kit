Feature: Runtime security
  Scenario: Runtime paths are isolated
    Given the omp-skill-kit repository exists
    When I inspect the runtime manifest
    Then the manifest pins uv and mega-tron digests
