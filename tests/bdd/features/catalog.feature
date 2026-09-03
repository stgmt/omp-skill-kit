Feature: Active catalog discovery and filtering
  Scenario: Workspace skills discovery filters out disabled skills
    Given an isolated project with valid, irrelevant, and forbidden skill fixtures
    When eligible skills are loaded for the project workspace
    Then only valid and irrelevant skills are included in the catalog
    And forbidden skills with disableModelInvocation are excluded
    And publishing the catalog creates an atomic revision snapshot
