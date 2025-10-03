import {
	assertEquals,
	assertThrows,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
	parseJsonObjectField,
	parseAllowedRoles,
	normalizeSlug,
	ensureNonEmptyString,
	parsePrimaryKey,
} from "./payload.ts";

Deno.test("parseJsonObjectField handles null-like values", () => {
	assertEquals(parseJsonObjectField(undefined, "test"), null);
	assertEquals(parseJsonObjectField(null, "test"), null);
	assertEquals(parseJsonObjectField("", "test"), null);
});

Deno.test("parseJsonObjectField parses JSON strings", () => {
	const result = parseJsonObjectField('{"foo":"bar"}', "field");
	assertEquals(result, { foo: "bar" });
});

Deno.test("parseJsonObjectField throws on invalid JSON", () => {
	assertThrows(() => parseJsonObjectField("not-json", "field"));
});

Deno.test("parseAllowedRoles normalizes inputs", () => {
	assertEquals(parseAllowedRoles(["admin", " admin "]), ["admin"]);
	assertEquals(parseAllowedRoles("user,editor"), ["user", "editor"]);
	assertEquals(parseAllowedRoles(""), ["user", "authenticated"]);
});

Deno.test("normalizeSlug lowercases and replaces spaces", () => {
	assertEquals(normalizeSlug("  My Slug  ", { resourceName: "teste", fieldLabel: "Slug" }), "my_slug");
});

Deno.test("normalizeSlug throws when empty", () => {
	assertThrows(() => normalizeSlug("   "), Error, "obrigatório");
});

Deno.test("ensureNonEmptyString trims and validates", () => {
	assertEquals(ensureNonEmptyString("  value  ", { fieldLabel: "Campo" }), "value");
	assertThrows(() => ensureNonEmptyString("   ", { fieldLabel: "Campo" }));
});

Deno.test("parsePrimaryKey handles strings and nulls", () => {
	assertEquals(parsePrimaryKey("  id  "), "id");
	assertEquals(parsePrimaryKey(null), null);
});
