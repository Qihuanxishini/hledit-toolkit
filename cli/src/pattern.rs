use regex::{Regex, RegexBuilder};
use regex_syntax::ast::{AssertionKind, Ast, RepetitionKind as R, RepetitionRange as Range};

pub struct Matcher {
    pub regex: Regex,
    pub broad: bool,
}

// [喵喵喵]: RE2 的 Perl 类和词边界是 ASCII，不能直接采用 Rust regex 的 Unicode 默认值；
// 普通字符、点号和大小写折叠仍保留 Unicode 语义，不能整体关闭 Unicode。
fn re2_expression(pattern: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut chars = pattern.chars().peekable();
    let mut in_class = false;
    let mut class_first = false;
    while let Some(c) = chars.next() {
        if c == '\\' {
            let escaped = chars.next().ok_or("trailing backslash")?;
            if matches!(escaped, 'u' | 'U') || (in_class && matches!(escaped, 'b' | 'B' | 'Q')) {
                return Err(format!("invalid RE2 escape: \\{escaped}"));
            }
            if escaped == 'Q' {
                let mut literal = String::new();
                while let Some(c) = chars.next() {
                    if c == '\\' && chars.peek() == Some(&'E') {
                        chars.next();
                        break;
                    }
                    literal.push(c);
                }
                out.push_str(&regex::escape(&literal));
            } else {
                let replacement = match escaped {
                    'd' => Some("[0-9]"),
                    'D' => Some("[^0-9]"),
                    'w' => Some("[0-9A-Za-z_]"),
                    'W' => Some("[^0-9A-Za-z_]"),
                    's' => Some("[\\t\\n\\f\\r ]"),
                    'S' => Some("[^\\t\\n\\f\\r ]"),
                    'b' if !in_class => Some("(?-u:\\b)"),
                    'B' if !in_class => Some("(?-u:\\B)"),
                    _ => None,
                };
                if let Some(replacement) = replacement {
                    out.push_str(replacement);
                } else {
                    out.push('\\');
                    out.push(escaped);
                }
            }
            class_first = false;
            continue;
        }
        if !in_class && c == '(' && chars.peek() == Some(&'?') {
            let mut flags = chars.clone();
            flags.next();
            if flags
                .peek()
                .is_some_and(|c| c.is_ascii_alphabetic() && *c != 'P' || *c == '-')
            {
                for flag in flags {
                    if flag == ')' || flag == ':' {
                        break;
                    }
                    if !matches!(flag, 'i' | 'm' | 's' | 'U' | '-') {
                        return Err(format!("unsupported RE2 flag: {flag}"));
                    }
                }
            }
        }
        if in_class {
            if c == ']' && !class_first {
                in_class = false;
            } else if c == '[' && chars.peek() == Some(&':') {
                // [喵喵喵]: POSIX 类保持原样；普通内嵌 '[' 在 RE2 中是字面量。
                out.push(c);
                for c in chars.by_ref() {
                    out.push(c);
                    if c == ']' {
                        break;
                    }
                }
                class_first = false;
                continue;
            } else if c == '[' || c == '&' || c == '~' || (c == ']' && class_first) {
                out.push('\\');
            }
            if c != '^' || !class_first {
                class_first = false;
            }
        } else if c == '[' {
            in_class = true;
            class_first = true;
        }
        out.push(c);
    }
    Ok(out)
}

#[derive(Default)]
struct PatternProperties {
    any_char: bool,
    skippable: bool,
    broad: bool,
}

// [喵喵喵]: 一次后序遍历计算三个属性；分别递归查询会在嵌套 concat 中重复访问子树，产生指数开销。
fn properties(ast: &Ast) -> PatternProperties {
    let mut result = PatternProperties::default();
    match ast {
        Ast::Dot(_) => result.any_char = true,
        Ast::Empty(_) | Ast::Flags(_) => result.skippable = true,
        Ast::Assertion(a) => {
            result.skippable = matches!(
                a.kind,
                AssertionKind::StartLine
                    | AssertionKind::EndLine
                    | AssertionKind::StartText
                    | AssertionKind::EndText
            );
        }
        Ast::Group(g) => return properties(&g.ast),
        Ast::Repetition(r) => {
            let child = properties(&r.ast);
            result.skippable = match r.op.kind {
                R::ZeroOrOne | R::ZeroOrMore => true,
                R::Range(Range::Exactly(0) | Range::AtLeast(0) | Range::Bounded(0, _)) => true,
                _ => child.skippable,
            };
            result.broad = match r.op.kind {
                R::ZeroOrMore | R::OneOrMore | R::Range(Range::AtLeast(0..=1)) => {
                    child.any_char || child.broad
                }
                _ => false,
            };
        }
        Ast::Concat(c) => {
            result.skippable = true;
            let mut all_unconstrained = true;
            for ast in &c.asts {
                let child = properties(ast);
                result.skippable &= child.skippable;
                result.broad |= child.broad;
                all_unconstrained &= child.broad || child.skippable;
            }
            result.broad &= all_unconstrained;
        }
        Ast::Alternation(a) => {
            for ast in &a.asts {
                let child = properties(ast);
                result.skippable |= child.skippable;
                result.broad |= child.broad;
            }
        }
        _ => {}
    }
    result
}

fn validate_repetitions(ast: &Ast, parent: u32) -> Result<(), String> {
    match ast {
        Ast::Repetition(r) => {
            let count = match r.op.kind {
                R::Range(Range::Exactly(n) | Range::AtLeast(n) | Range::Bounded(_, n)) => n,
                _ => 1,
            };
            let count = parent.saturating_mul(count);
            if count > 1000 {
                return Err("RE2 repeat count exceeds 1000".into());
            }
            validate_repetitions(&r.ast, count)?;
        }
        Ast::Group(g) => validate_repetitions(&g.ast, parent)?,
        Ast::Concat(c) => {
            for ast in &c.asts {
                validate_repetitions(ast, parent)?;
            }
        }
        Ast::Alternation(a) => {
            for ast in &a.asts {
                validate_repetitions(ast, parent)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn compile(pattern: &str, literal: bool, ignore_case: bool) -> Result<Matcher, String> {
    let expression = if literal {
        regex::escape(pattern)
    } else {
        re2_expression(pattern)?
    };
    // [喵喵喵]: 转义后的字面量没有重复算子或宽匹配结构；仍由同一 RegexBuilder 保留匹配与编译限制。
    let broad = if literal {
        false
    } else {
        let ast = regex_syntax::ast::parse::ParserBuilder::new()
            .octal(true)
            .build()
            .parse(&expression)
            .map_err(|e| e.to_string())?;
        validate_repetitions(&ast, 1)?;
        properties(&ast).broad
    };
    let regex = RegexBuilder::new(&expression)
        .case_insensitive(ignore_case)
        .octal(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Matcher { regex, broad })
}
