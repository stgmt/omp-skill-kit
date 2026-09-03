Feature: Semantic routing
  Scenario: The bridge protocol carries a bounded ranking request
    Given the omp-skill-kit repository exists
    When I inspect the bridge protocol
    Then the protocol exposes ping warmup rank and shutdown
