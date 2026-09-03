Feature: Release artifact packaging and plugin verification
  Scenario: Release archive adheres to strict allowlist and verifiable integrity
    Given a clean temporary staging directory
    When I build and package the release archive
    Then the release archive and sha256 checksum are created
    And the unpacked archive contains all required entrypoints
    And the unpacked archive contains no source code or dev dependencies
    And the plugin links into an isolated OMP profile with doctor status ok
