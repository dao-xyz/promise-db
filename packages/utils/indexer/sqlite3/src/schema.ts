import {
	type Constructor,
	getSchema,
	type FieldType,
	OptionKind,
	VecKind,
	WrappedType,
	getDependencies,
	type Field, field as fieldDecalaration, type AbstractType, variant,
	deserialize, serialize
} from "@dao-xyz/borsh";
import * as types from "@peerbit/indexer-interface";
import { toHexString } from "@peerbit/crypto";

const SQLConversionMap: any = {
	u8: "INTEGER",
	u16: "INTEGER",
	u32: "INTEGER",
	u64: "INTEGER",
	i8: "INTEGER",
	i16: "INTEGER",
	i32: "INTEGER",
	i64: "INTEGER",
	f32: "REAL",
	f64: "REAL",
	bool: "INTEGER",
	string: "TEXT",
	Uint8Array: "BLOB",
	Date: "TEXT"
};

const WRAPPED_SIMPLE_VALUE_VARIANT = "wrapped";

export type SQLLiteValue =
	| string
	| number
	| null
	| bigint
	| Uint8Array
	| Int8Array
	| ArrayBuffer;

export type BindableValue = string | bigint | number | Uint8Array | Int8Array | ArrayBuffer | null

export const convertToSQLType = (
	value: boolean | bigint | string | number | Uint8Array,
	type?: FieldType
): BindableValue => {
	// add bigint when https://github.com/TryGhost/node-sqlite3/pull/1501 fixed

	if (type === "bool") {
		if (value != null) {
			return value ? 1 : 0;
		}
		return null;
	}
	return value as BindableValue;
};

const nullAsUndefined = (value: any) => value === null ? undefined : value;

export const convertFromSQLType = (
	value: boolean | bigint | string | number | Uint8Array,
	type?: FieldType
) => {

	if (type === "bool") {
		if (value === 0 || value === 1 || value === 0n || value === 1n || typeof value === 'boolean') {
			return value ? true : false
		}
		return nullAsUndefined(value);
	}
	if (type === 'u8' || type === 'u16' || type === 'u32') {
		return typeof value === 'bigint' || typeof value === 'string' ? Number(value) : nullAsUndefined(value);
	}
	if (type === 'u64') {
		return typeof value === 'number' || typeof value === 'string' ? BigInt(value) : nullAsUndefined(value);
	}
	return nullAsUndefined(value);
}

export const toSQLType = (type: FieldType, isOptional = false) => {
	let ret: string;
	if (typeof type === "string") {
		const sqlType = SQLConversionMap[type];
		if (!sqlType) {
			throw new Error(`Type ${type} is not supported in SQL`);
		}
		ret = sqlType;
	} else if (type === Uint8Array) {
		ret = "BLOB";
	} else if (type instanceof OptionKind) {
		throw new Error("Unexpected option");
	} else if (type instanceof VecKind) {
		throw new Error("Unexpected vec");
	} else {
		throw new Error(`Type ${type} is not supported in SQL`);
	}

	return isOptional ? ret : ret + " NOT NULL";
};

type SQLField = { name: string, key: string, definition: string; type: string, isPrimary: boolean, from: Field | undefined, path: string[], describesExistenceOfAnother?: string };
type SQLConstraint = { name: string; definition: string };

export interface Table {
	name: string;
	ctor: Constructor<any>;
	primary: string | false;
	primaryIndex: number,
	path: string[],
	parentPath: string[] | undefined, // field path of the parent where this table originates from
	fields: SQLField[];
	constraints: SQLConstraint[];
	children: Table[];
	inline: boolean;
	parent: Table | undefined
	referencedInArray: boolean,
	isSimpleValue: boolean
}


export const getSQLTable = (
	ctor: AbstractType<any>,
	path: string[],
	primary: string | false,
	inline: boolean,
	addJoinField: ((fields: SQLField[], constraints: SQLConstraint[]) => void) | undefined,
	fromOptionalField: boolean = false

	/* name: string */
): Table[] => {

	let clazzes = getDependencies(ctor, 0) as any as Constructor<any>[];
	if (!clazzes) {
		clazzes = [ctor as Constructor<any>]
	}

	let ret: Table[] = [];
	for (const ctor of clazzes) {

		const name = getTableName(path, getNameOfClass(ctor));
		const newPath: string[] = inline ? path : [name]
		const { constraints, fields, dependencies } = getSQLFields(
			name,
			newPath,
			ctor,
			primary,
			addJoinField,
			[],
			fromOptionalField
		);

		const table: Table = {
			name,
			constraints,
			fields,
			ctor,
			parentPath: path,
			path: newPath,
			primary,
			primaryIndex: fields.findIndex(x => x.isPrimary),
			children: dependencies,
			parent: undefined,
			referencedInArray: false,
			isSimpleValue: false,
			inline
		}
		ret.push(table)
		for (const dep of dependencies) {
			dep.parent = table
			// ret.push(dep)
		}


	}

	return ret;

};

const getNameOfVariant = (variant: any) => {
	return "v_" + (typeof variant === "string"
		? variant
		: JSON.stringify(variant));
}

const getNameOfClass = (ctor: AbstractType<any>) => {
	let name: string;
	const schema = getSchema(ctor);
	if (!schema) {
		throw new Error("Schema not found for " + ctor.name)
	}
	if (schema.variant === undefined) {
		/* TODO when to display warning? 	
		console.warn(
				`Schema associated with ${ctor.name} has no variant.  This will results in SQL table with name generated from the Class name. This is not recommended since changing the class name will result in a new table`
			); */
		name = "class_" + ctor.name;
	} else {
		name = getNameOfVariant(schema.variant)
	}
	return name
}

export const getTableName = (path: string[] = [], clazz: string | Constructor<any>) => {
	let name: string = typeof clazz === 'string' ? clazz : getNameOfClass(clazz);

	// prefix the generated table name so that the name is a valid SQL identifier (table name)
	// choose prefix which is readable and explains that this is a generated table name

	// leading _ to allow path to have numbers

	const ret = (path.length > 0 ? (path.join("__") + "__") : "") + name.replace(/[^a-zA-Z0-9_]/g, "_");
	return ret
};


export const CHILD_TABLE_ID = "__id";
export const ARRAY_INDEX_COLUMN = "__index";

export const PARENT_TABLE_ID = "__parent_id";
const FOREIGN_VALUE_PROPERTY = "value";

/* const clazzHasVariants = (clazz: Constructor<any>) => {
	const schema = getSchema(clazz);
	return schema?.variant !== undefined;

}
 */
const clazzCanBeInlined = (clazz: Constructor<any>) => {
	return /* clazzHasVariants(clazz) === false &&  */((getDependencies(clazz, 0)?.length ?? 0) === 0);
}

interface SimpleNested { [FOREIGN_VALUE_PROPERTY]: any };


const getInlineObjectExistColumnName = () => {
	return "_exist";
}

export const getSQLFields = (
	tableName: string,
	path: string[],
	ctor: Constructor<any>,
	primary: string | false,
	addJoinFieldFromParent?: (fields: SQLField[], constraints: SQLConstraint[]) => void,
	tables: Table[] = [],
	isOptional = false
): {

	fields: SQLField[];
	constraints: SQLConstraint[];
	dependencies: Table[];
} => {
	const schema = getSchema(ctor);
	const fields = schema.fields;
	const sqlFields: SQLField[] = [];
	const sqlConstraints: SQLConstraint[] = [];

	let foundPrimary = false;




	const addJoinFields = primary === false ? addJoinFieldFromParent : (fields: SQLField[], contstraints: SQLConstraint[]) => {

		// we resolve primary field here since it might be unknown until this point
		const primaryField = primary && sqlFields.find((field) => field.name === primary);
		const parentPrimaryFieldName = (primaryField && primaryField.key) || CHILD_TABLE_ID;
		const parentPrimaryFieldType = primaryField
			? primaryField.type
			: "INTEGER"

		fields.unshift(
			{
				name: CHILD_TABLE_ID,
				key: CHILD_TABLE_ID,
				definition: `${CHILD_TABLE_ID} INTEGER PRIMARY KEY`,
				type: "INTEGER",
				isPrimary: true,
				from: undefined,
				path: [CHILD_TABLE_ID]
			},

			// foreign key parent document
			{
				name: PARENT_TABLE_ID,
				key: PARENT_TABLE_ID,
				definition: `${PARENT_TABLE_ID} ${parentPrimaryFieldType}`,
				type: parentPrimaryFieldType,
				isPrimary: false,
				from: undefined,
				path: [PARENT_TABLE_ID]
			},

		)
		contstraints.push({
			name: `${PARENT_TABLE_ID}_fk`,
			definition: `CONSTRAINT ${PARENT_TABLE_ID}_fk FOREIGN KEY(${PARENT_TABLE_ID}) REFERENCES ${tableName}(${parentPrimaryFieldName}) ON DELETE CASCADE`
		})
	}



	const handleNestedType = (key: string, field: VecKind | Constructor<any> | AbstractType<any>) => {
		let chilCtor: Constructor<any>;

		let elementType: any;
		let isVec = false;
		if (field instanceof VecKind) {
			if (field.elementType instanceof VecKind) {
				throw new Error("vec(vec(...)) is not supported");
			}
			elementType = field.elementType;
			isVec = true;
		}
		else {
			elementType = field;
		}


		let isSimpleValue = false;
		if (
			typeof elementType === "function" &&
			elementType != Uint8Array
		) {
			chilCtor = elementType as Constructor<any>;
		} else {
			@variant(WRAPPED_SIMPLE_VALUE_VARIANT)
			class SimpleNested implements SimpleNested {

				@fieldDecalaration({ type: elementType })
				[FOREIGN_VALUE_PROPERTY]: any;

				constructor(value: any) {
					this[FOREIGN_VALUE_PROPERTY] = value;
				}
			}
			chilCtor = SimpleNested;
			isSimpleValue = true;
		}




		const subtables = getSQLTable(chilCtor, [...path, key], CHILD_TABLE_ID, false, addJoinFields);

		for (const table of subtables) {
			if (!tables.find((x) => x.name === table.name)) {
				if (isVec) {
					table.referencedInArray = true;

					table.fields = [
						...table.fields.slice(0, 2),
						{
							name: ARRAY_INDEX_COLUMN,
							key: ARRAY_INDEX_COLUMN,
							definition: ARRAY_INDEX_COLUMN + ' INTEGER',
							type: 'INTEGER',
							isPrimary: false,
							from: undefined,
							path: [ARRAY_INDEX_COLUMN]
						},
						...table.fields.slice(2)
					]
				}
				table.isSimpleValue = isSimpleValue
				tables.push(table);
			}
		}
	};

	const handleSimpleField = (key: string, field: Field, type: FieldType, isOptional: boolean) => {
		let keyString = getInlineTableFieldName(path.slice(1), key)

		const isPrimary = primary != null && keyString === primary
		foundPrimary = foundPrimary || isPrimary;

		const fieldType = toSQLType(type, isOptional);
		sqlFields.push({
			name: keyString,
			key,
			definition: `'${keyString}' ${fieldType} ${isPrimary ? "PRIMARY KEY" : ""}`,
			type: fieldType,
			isPrimary,
			from: field,
			path: [...path.slice(1), key]
		});
	};

	const handleField = (key: string, field: Field, type: FieldType, isOptional: boolean) => {
		if (
			typeof type === "string" ||
			type == Uint8Array
		) {
			handleSimpleField(key, field, type, true);
		}
		else if (typeof type === 'function' && clazzCanBeInlined(type as Constructor<any>)) {
			// if field is object but is not polymorphic we can do a simple field inlining

			const subPath = [...path, key]
			const subtables = getSQLTable(type as Constructor<any>, subPath, false, true, addJoinFields, isOptional);
			for (const table of subtables) {
				if (!tables.find((x) => x.name === table.name)) {
					tables.push(table);
					if (table.inline) {
						for (const field of table.fields) {
							const isPrimary = primary != null && field.name === primary
							foundPrimary = foundPrimary || isPrimary;
							sqlFields.push(field);
						}
						sqlConstraints.push(...table.constraints);
					}
				}
			}


		}
		else if (typeof type === "function") {
			handleNestedType(key, type)
		} else {
			throw new Error(
				`Unsupported type in option, ${typeof type}: ${typeof type}`
			);
		}
	}

	for (const field of fields) {
		if (field.type instanceof VecKind) {
			handleNestedType(field.key, field.type);
		} else if (field.type instanceof OptionKind) {
			if (field.type.elementType instanceof VecKind) {
				// TODO but how ? 
				throw new Error("option(vec(T)) not supported");
			} else if (field.type.elementType instanceof OptionKind) {
				throw new Error("option(option(T)) not supported");
			}
			handleField(field.key, field, field.type.elementType, true)
		} else {
			handleField(field.key, field, field.type, isOptional)
		}
	}

	if (primary !== false) {  // primareKey will be false for nested objects that are inlined
		if (!foundPrimary && primary != CHILD_TABLE_ID) {
			throw new Error(`Primary key ${primary} not found in schema`);
		}
		addJoinFieldFromParent?.(sqlFields, sqlConstraints)
	}

	else {
		// inline 
		if (isOptional) {
			// add field indicating if the inline object exists,
			let key = getInlineObjectExistColumnName();
			let keyString = getInlineTableFieldName(path.slice(1), key)

			sqlFields.push({
				name: keyString,
				key,
				definition: `'${keyString}' INTEGER`,
				type: 'bool',
				isPrimary: false,
				from: undefined,
				path: [...path.slice(1), key],
				describesExistenceOfAnother: path[path.length - 1]
			});
		}
	}


	return {
		fields: sqlFields,
		constraints: sqlConstraints,
		dependencies: tables,
	};
};

export const resolveTable = <B extends boolean, R = B extends true ? Table : (Table | undefined)>(
	key: string[],
	tables: Map<string, Table>,
	clazz: string | Constructor<any>,
	throwOnMissing: B
): R => {
	const name = /* key == null ? */ getTableName(key, clazz) /* : getSubTableName(scope, key, ctor); */
	const table = tables.get(name) || tables.get(getTableName(key, getNameOfVariant(WRAPPED_SIMPLE_VALUE_VARIANT)) /* key.join("__") + "__" + getNameOfVariant(WRAPPED_SIMPLE_VALUE_VARIANT) */);
	if (!table && throwOnMissing) {
		throw new Error(`Table not found for ${name}: ${Array.from(tables.keys())}`);
	}
	return table as R;
};


const isNestedType = (type: FieldType): type is AbstractType<any> => {
	const unwrapped = unwrapNestedType(type);
	return typeof unwrapped === "function" && unwrapped !== Uint8Array;
}
const unwrapNestedType = (type: FieldType): FieldType => {
	if (type instanceof WrappedType) {
		return type.elementType;
	}
	return type


}

const getTableFromField = (parentTable: Table, tables: Map<string, Table>, field: Field) => {

	if (!field) {

		throw new Error("Field is undefined")

	}
	let clazzNames: string[] = [];
	if (!isNestedType(field.type)) {
		clazzNames.push(WRAPPED_SIMPLE_VALUE_VARIANT)
	}
	else {
		const testCtors: any[] = [unwrapNestedType(field.type), ...(getDependencies(unwrapNestedType(field.type) as any, 0) || []) as Constructor<any>[]]
		for (const ctor of testCtors) {
			if (!ctor) {
				continue;
			}
			const schema = getSchema(ctor);
			if (!schema) {
				continue;
			}
			if (ctor) {
				clazzNames.push(getNameOfClass(ctor))
			}

		}
	}
	if (clazzNames.length === 0) {
		throw new Error("Could not find class name")
	}

	const subTable = clazzNames.map(clazzName => resolveTable([...parentTable.path, field.key], tables, clazzName, false)).filter(x => x != null)
	return subTable;



}

const getTableFromValue = (parentTable: Table, tables: Map<string, Table>, field: Field, value?: any): Table => {

	try {
		let clazzName: string | undefined = undefined;
		if (!isNestedType(field.type)) {
			clazzName = WRAPPED_SIMPLE_VALUE_VARIANT
		}
		else {
			try {
				const testCtors = value?.constructor ? [value?.constructor] : [unwrapNestedType(field.type), ...(getDependencies(unwrapNestedType(field.type) as any, 0) || [])] as Constructor<any>[]
				for (const ctor of testCtors) {
					if (!ctor) {
						continue;
					}
					const schema = getSchema(ctor);
					if (!schema) {
						continue;
					}
					if (ctor) {
						clazzName = getNameOfClass(ctor);
						break;
					}

				}
			} catch (error) {
				throw error
			}
		}
		if (!clazzName) {
			throw new Error("Could not find class name")
		}

		const subTable = resolveTable([...parentTable.path, field.key], tables, clazzName, true);
		return subTable;
	} catch (error) {
		throw error
	}


}


export const insert = async (
	insertFn: (values: any[], table: Table) => Promise<any> | any,
	obj: Record<string, any>,
	tables: Map<string, Table>,
	table: Table,
	fields: Field[],
	handleNestedCallback?: (cb: (parentId: any) => Promise<void>) => void,
	parentId: any = undefined,
	index?: number,
): Promise<void> => {

	const bindableValues: any[] = [];
	let nestedCallbacks: ((id: any) => Promise<void>)[] = [];

	handleNestedCallback = table.primary === false ? handleNestedCallback : (fn) => nestedCallbacks.push(fn);

	const handleElement = async (item: any, field: Field, parentId: any, index?: number) => {
		const subTable = getTableFromValue(table, tables, field, item);

		await insert(
			insertFn,
			(typeof item === "function" && item instanceof Uint8Array === false) ? item : subTable.isSimpleValue ? new subTable.ctor(item) : Object.assign(Object.create(subTable.ctor.prototype), item),
			tables,
			subTable,
			getSchema(subTable.ctor).fields,
			handleNestedCallback,
			parentId,
			index
		);

	}

	const handleNested = async (field: Field, optional: boolean, parentId: any) => {
		if (Array.isArray(obj[field.key])) {
			const arr = obj[field.key];
			for (let i = 0; i < arr.length; i++) {
				const item = arr[i];
				await handleElement(item, field, parentId, i);
			}
		} else {
			if (field instanceof VecKind) {
				if (obj[field.key] == null) {
					if (!optional) {
						throw new Error("Expected array, received null");
					} else {
						return;
					}
				}
				throw new Error("Expected array");
			}

			const value = obj[field.key]
			if (value == null) {
				if (!optional) {
					throw new Error("Expected object, received null")
				}
				return;
			}
			await handleElement(value, field, parentId);

		}
	};

	let nestedFields: Field[] = [];
	if (parentId != null) {
		bindableValues.push(undefined);
		bindableValues.push(parentId);
		if (index != null) {
			bindableValues.push(index);
		}

	}


	for (const field of fields) {
		const unwrappedType = unwrapNestedType(field.type);
		if (field.type instanceof VecKind === false) {
			if (typeof unwrappedType === "string" || unwrappedType == Uint8Array) {
				bindableValues.push(convertToSQLType(obj[field.key], unwrappedType));
			}
			else if (typeof unwrappedType === "function" && clazzCanBeInlined(unwrappedType as Constructor<any>)) {
				const value = obj[field.key]
				const subTable = getTableFromValue(table, tables, field, value);
				if (subTable.inline && value == null) {
					for (const _field of subTable.fields) {
						bindableValues.push(null)
					}
					bindableValues[bindableValues.length - 1] = false  // assign the value "false" to the exist field column
					continue;
				}

				await insert((values, table) => {
					if (table.inline) {
						bindableValues.push(...values) // insert the bindable values into the parent bindable array
						if (field.type instanceof OptionKind) {
							bindableValues.push(true); // assign the value "true" to the exist field column
						}
						return undefined
					}
					else {
						return insertFn(values, table)
					}
				}, value, tables, subTable, getSchema(unwrappedType).fields, (fn) => nestedCallbacks.push(fn), parentId, index);
				/* await insert(, obj[field.key], tables, subTable, getSchema(unwrappedType).fields, parentId, index); */
			}
			else {
				nestedFields.push(field);
			}
		}
		else {
			nestedFields.push(field);
		}

	}

	// we handle nested after self insertion so we have a id defined for 'this'
	// this is important because if we insert a related document in a foreign table
	// we need to know the id of the parent document to insert the foreign key correctly
	for (const nested of nestedFields) {
		const isOptional = nested.type instanceof OptionKind;
		handleNestedCallback!((id) => handleNested(nested, isOptional, id))
	}

	const thisId = await insertFn(bindableValues, table);
	if (table.primary === false && nestedCallbacks.length > 0) {
		throw new Error("Unexpected")
	}
	await Promise.all(nestedCallbacks.map(x => x(thisId)))


	/* return [result, ...ret]; */
};

export const getTablePrefixedField = (table: Table, key: string, skipPrefix: boolean = false) => `${skipPrefix ? '' : table.name + "#"}${getInlineTableFieldName(table.path.slice(1), key)}`
export const getTableNameFromPrefixedField = (prefixedField: string) => prefixedField.split("#")[0]
export const getInlineTableFieldName = (path: string[] | undefined, key: string) => path && path.length > 0 ? `${path.join("_")}__${key}` : key;

const matchFieldInShape = (shape: types.Shape | undefined, path: string[] | undefined, field: SQLField) => {
	if (!shape) {
		return true
	}
	let currentShape = shape

	if (field.path) {
		for (let i = 0; i < field.path.length; i++) {
			if (!currentShape) {
				return false
			}
			let nextShape = currentShape[field.path[i]]
			if (nextShape === undefined) {
				return false
			}
			if (nextShape === true) {
				return true
			}
			currentShape = nextShape
		}
	}

	throw new Error("Unexpected")
}

export const selectChildren = (childrenTable: Table) => "select * from " + childrenTable.name + " where " + PARENT_TABLE_ID + " = ?"

export const selectAllFields = (table: Table, shape: types.Shape | undefined) => {
	let stack: { table: Table, shape?: types.Shape }[] = [{ table, shape }];
	let join: Map<string, JoinTable> = new Map();
	const fieldResolvers: string[] = []
	for (const tableAndShape of stack) {

		if (!tableAndShape.table.inline) {
			for (const field of tableAndShape.table.fields) {
				if (field.isPrimary || !tableAndShape.shape || matchFieldInShape(tableAndShape.shape, [], field)) {
					const value = `${tableAndShape.table.name}.${field.name} as '${getTablePrefixedField(tableAndShape.table, field.name)}'`
					fieldResolvers.push(value)
				}
			}
		}

		for (const child of tableAndShape.table.children) {
			if (child.referencedInArray) {
				continue;
			}

			let childShape: types.Shape | undefined = undefined
			if (tableAndShape.shape) {
				const parentPath = child.parentPath?.slice(1);
				let maybeShape = parentPath ? tableAndShape.shape?.[parentPath[parentPath.length - 1]] : undefined

				if (!maybeShape) {
					continue;
				}

				childShape = maybeShape === true ? undefined : maybeShape

			}

			stack.push({ table: child, shape: childShape })
			if (!child.inline) {
				join.set(child.name, { as: child.name, table: child })
			}
		}
	}

	if (fieldResolvers.length === 0) {
		throw new Error("No fields to resolve")
	}

	return { query: `SELECT ${fieldResolvers.join(", ")} FROM ${table.name}`, join };
}

const getNonInlinedTable = (from: Table) => {
	let current: Table = from;
	while (current.inline) {
		if (!current.parent) {
			throw new Error("No parent found")
		}
		current = current.parent
	}
	return current
}

// the inverse of resolveFieldValues
export const resolveInstanceFromValue = async <T>(
	fromTablePrefixedValues: Record<string, any>,
	tables: Map<string, Table>,
	table: Table,
	resolveChildren: (parentId: any, table: Table) => Promise<any[]>,
	tablePrefixed: boolean,
	shape: types.Shape | undefined
): Promise<T> => {

	const fields = getSchema(table.ctor).fields;
	const obj: any = {};

	const handleNested = async (field: Field, isOptional: boolean, isArray: boolean) => {
		const subTables = getTableFromField(table, tables, field); // TODO fix

		let maybeShape = shape?.[field.key]
		let subshape = maybeShape === true ? undefined : maybeShape

		if (isArray) {
			let once = false
			let resolvedArr = [];

			for (const subtable of subTables) {
				// TODO types
				let rootTable = getNonInlinedTable(table);
				const arr = await resolveChildren(fromTablePrefixedValues[getTablePrefixedField(rootTable, rootTable.primary as string, !tablePrefixed)], subtable);
				if (arr) {
					once = true
					for (const element of arr) {
						const resolved: SimpleNested | any = await resolveInstanceFromValue(
							element,
							tables,
							subtable, // TODO fix
							resolveChildren,
							false,
							subshape
						);

						resolvedArr[element[ARRAY_INDEX_COLUMN]] = (subtable.isSimpleValue ? resolved.value : resolved);
					}
				}
			}


			if (!once) {
				obj[field.key] = undefined
			}
			else {
				obj[field.key] = resolvedArr;
			}


		}
		else {

			// resolve nested object from row directly 
			/* let extracted: any = {} */
			let subTable: Table | undefined = undefined
			if (subTables.length > 1) {
				for (const table of subTables) {
					// TODO types
					if (fromTablePrefixedValues[getTablePrefixedField(table, table.primary as string, !tablePrefixed)] != null) {
						subTable = table
						break
					}
				}
			}
			else {
				subTable = subTables[0]
			}

			if (!subTable) {
				throw new Error("Sub table not found")
			}
			/* 
						for (const field of subTable.fields) {
							once = true
							extracted[field.name] = fromTablePrefixedValues[getTablePrefixedField(subTable, field.name, !tablePrefixed)]
						}
			 */

			if (subTable.inline && isOptional) {


				let rootTable = getNonInlinedTable(table);

				const isNull = !fromTablePrefixedValues[getTablePrefixedField(rootTable, subTable.fields[subTable.fields.length - 1].name)]


				if (isNull) {
					obj[field.key] = undefined
					return
				}
			}

			// TODO types
			if (subTable.primary != false && fromTablePrefixedValues[getTablePrefixedField(subTable, subTable.primary, !tablePrefixed)] == null) {
				obj[field.key] = undefined
			}
			else {
				const resolved = await resolveInstanceFromValue(
					fromTablePrefixedValues,
					tables,
					subTable,
					resolveChildren,
					tablePrefixed,
					subshape
				);

				obj[field.key] = resolved;
			}

		}


	};


	for (const field of fields) {

		if (shape && !shape[field.key]) {
			continue
		}

		const rootTable = getNonInlinedTable(table);
		const referencedField = rootTable.fields.find(sqlField => sqlField.from === field)
		const fieldValue = referencedField ? fromTablePrefixedValues[getTablePrefixedField(rootTable, referencedField!.name, !tablePrefixed)] : undefined;
		if (typeof field.type === "string" || field.type == Uint8Array) {
			obj[field.key] = convertFromSQLType(fieldValue, field.type);
		} else if (field.type instanceof OptionKind) {
			if (typeof field.type.elementType === "string" || field.type.elementType == Uint8Array) {
				obj[field.key] = convertFromSQLType(fieldValue, field.type.elementType);
			}
			else if (field.type.elementType instanceof VecKind) {
				await handleNested(field, true, true);
			}
			else {
				await handleNested(field, true, false);
			}
		} else if (field.type instanceof VecKind) {
			await handleNested(field, false, true);
		} else {
			await handleNested(field, false, false);
		}
	}


	return Object.assign(Object.create(table.ctor.prototype), obj);
}

export const fromRowToObj = (row: any, ctor: Constructor<any>) => {
	const schema = getSchema(ctor);
	const fields = schema.fields;
	const obj: any = {};
	for (const field of fields) {
		obj[field.key] = row[field.key];
	}
	return Object.assign(Object.create(ctor.prototype), obj);
};

export const convertDeleteRequestToQuery = (request: types.DeleteRequest, tables: Map<string, Table>, table: Table) => {
	return `DELETE FROM ${table.name} WHERE ${table.primary} IN (SELECT ${table.primary} from ${table.name} ${convertRequestToQuery(request, tables, table).query}) returning ${table.primary}`;
}


export const convertSumRequestToQuery = (request: types.SumRequest, tables: Map<string, Table>, table: Table) => {
	return `SELECT SUM(${table.name}.${request.key.join(".")}) as sum FROM ${table.name} ${convertRequestToQuery(request, tables, table).query}`;
}

export const convertCountRequestToQuery = (request: types.CountRequest, tables: Map<string, Table>, table: Table) => {
	return `SELECT count(*) as count FROM ${table.name} ${convertRequestToQuery(request, tables, table).query}`;
}

export const convertSearchRequestToQuery = (request: types.SearchRequest, tables: Map<string, Table>, rootTables: Table[], shape: types.Shape | undefined) => {
	let unionBuilder = "";
	let orderByClause: string | undefined = undefined;
	for (const table of rootTables) {
		const { query: selectQuery, join: joinFromSelect } = selectAllFields(table, shape)
		const { orderBy, query } = convertRequestToQuery(request, tables, table, joinFromSelect)
		unionBuilder += `${unionBuilder.length > 0 ? " UNION ALL " : ""} ${selectQuery} ${query}`
		orderByClause = orderBy?.length > 0 ? orderBy : orderByClause
	}

	return `${unionBuilder} ${orderByClause ? orderByClause : ''} limit ? offset ?`;

}


type SearchQueryParts = { query: string; orderBy: string }
type CountQueryParts = { query: string; join: string }

const convertRequestToQuery = <T extends (types.SearchRequest | types.CountRequest | types.SumRequest), R = T extends types.SearchRequest ? SearchQueryParts : CountQueryParts>(
	request: T,
	tables: Map<string, Table>,
	table: Table,
	extraJoin?: Map<string, JoinTable>,
	path: string[] = [],
): R => {
	let whereBuilder = "";
	let orderByBuilder: string | undefined = undefined;
	/* let tablesToSelect: string[] = [table.name]; */
	let joinBuilder: Map<string, JoinTable> = extraJoin || new Map();

	if (request.query.length === 1) {
		const { where } = convertQueryToSQLQuery(
			request.query[0],
			tables,
			table,
			joinBuilder,
			path
		);
		whereBuilder += where;
	} else if (request.query.length > 1) {
		const { where } = convertQueryToSQLQuery(
			new types.And(request.query),
			tables,
			table,
			joinBuilder,
			path
		);
		whereBuilder += where;
	}

	if (request instanceof types.SearchRequest) {
		if (request.sort.length > 0) {
			if (request.sort.length > 0) {
				orderByBuilder = "ORDER BY ";
			}
			let once = false
			for (const sort of request.sort) {
				const { foreignTables, queryKey } = resolveTableToQuery(table, tables, joinBuilder, [...path, ...sort.key], undefined, true);
				for (const table of foreignTables) {
					if (once) {
						orderByBuilder += ", "
					}
					once = true;
					orderByBuilder += `${table.as}.${queryKey} ${sort.direction === types.SortDirection.ASC ? "ASC" : "DESC"}`
				}
			}

			/* orderByBuilder += request.sort
				.map(
					(sort) =>
						`${table.name}.${sort.key} ${sort.direction === types.SortDirection.ASC ? "ASC" : "DESC"}`
				)
				.join(", "); */
		}
	}
	const where = whereBuilder.length > 0 ? "where " + whereBuilder : undefined;


	if (extraJoin && extraJoin.size > 0) {
		insertMapIntoMap(joinBuilder, extraJoin)
	}
	let join = buildJoin(joinBuilder, request instanceof types.SearchRequest ? true : false);

	const query = `${join ? join : ""} ${where ? where : ""}`;

	return {
		query,
		orderBy: orderByBuilder
	} as R;
};

export const buildJoin = (joinBuilder: Map<string, JoinTable>, resolveAllColumns: boolean) => {
	let joinTypeDefault = resolveAllColumns ? /* "FULL OUTER JOIN" */ "LEFT OUTER JOIN" : "JOIN";
	let join = ""
	for (const [_key, table] of joinBuilder) {

		let nonInlinedParent = table.table.parent && getNonInlinedTable(table.table.parent)
		if (!nonInlinedParent) {
			throw new Error("Unexpected: missing parent")
		}

		let joinType = table.table.referencedInArray ?/* "FULL OUTER JOIN" */ "LEFT OUTER JOIN" : joinTypeDefault;
		join += `${joinType} ${table.table.name} AS ${table.as} ON ${nonInlinedParent.name}.${nonInlinedParent.primary} = ${table.as}.${PARENT_TABLE_ID} `
	}
	return join;
}

const insertMapIntoMap = (map: Map<string, any>, insert: Map<string, any>) => {
	for (const [key, value] of insert) {
		map.set(key, value);
	}
}

export const convertQueryToSQLQuery = (
	query: types.Query,
	tables: Map<string, Table>,
	table: Table,
	joinBuilder: Map<string, JoinTable>,
	path: string[] = [],
	tableAlias: string | undefined = undefined
): { where: string; } => {
	let whereBuilder = "";
	/* 	let tablesToSelect: string[] = []; */

	const handleAnd = (queries: types.Query[], path: string[], tableAlias?: string) => {
		for (const query of queries) {
			const { where } = convertQueryToSQLQuery(query, tables, table, joinBuilder, path, tableAlias);
			whereBuilder =
				whereBuilder.length > 0 ? `(${whereBuilder}) AND (${where})` : where;
		}
	}

	if (query instanceof types.StateFieldQuery) {
		const { where } = convertStateFieldQuery(query, tables, table, joinBuilder, path, tableAlias);
		whereBuilder += where;
	} else if (query instanceof types.Nested) {
		let joinPrefix = "__" + String(tables.size);
		path = [...path, query.path]
		handleAnd(query.query, path, joinPrefix)
	} else if (query instanceof types.LogicalQuery) {
		if (query instanceof types.And) {
			handleAnd(query.and, path, tableAlias)
		} else if (query instanceof types.Or) {
			for (const subquery of query.or) {
				const { where } = convertQueryToSQLQuery(subquery, tables, table, joinBuilder, path, tableAlias);
				whereBuilder =
					whereBuilder.length > 0 ? `(${whereBuilder}) OR (${where})` : where;
			}
		}
		else if (query instanceof types.Not) {
			const { where } = convertQueryToSQLQuery(query.not, tables, table, joinBuilder, path, tableAlias);
			whereBuilder = `NOT (${where})`;
		}
		else {
			throw new Error("Unsupported query type: " + query.constructor.name);
		}
	} else {
		throw new Error("Unsupported query type: " + query.constructor.name);
	}

	return {
		where: whereBuilder
	};
};

const cloneQuery = (query: types.StateFieldQuery) => {
	return deserialize(serialize(query), types.StateFieldQuery);
};


type JoinTable = {
	table: Table,
	as: string
}

const createTableReferenceName = (table: Table, alias: string | undefined, fieldType: FieldType, joinSize: number) => {
	if (!alias && (fieldType instanceof VecKind || (fieldType instanceof OptionKind && fieldType.elementType instanceof VecKind))) {
		let aliasSuffix = "_" + String(joinSize);
		alias = aliasSuffix
	}
	const tableNameAs = alias ? (alias + "_" + table.name) : table.name
	return tableNameAs
}

const resolveTableToQuery = (table: Table, tables: Map<string, Table>, join: Map<string, JoinTable>,
	path: string[], alias: string | undefined, searchSelf: boolean) => {

	// we are matching in two ways. 

	// 1. joins
	// we go down the path and resolve related tables until the last index
	// the last path value is the query key

	// 2. inline table fields
	// multiple keys in the path can correspond to a field in a inline table
	// this means we need to also check if the key is a field in the current table

	try {
		if (searchSelf) {
			const inlineName = getInlineTableFieldName(path.slice(0, -1), path[path.length - 1])
			let field = table.fields.find(x => x.name === inlineName)
			if (field) {
				return { queryKey: field.name, foreignTables: [{ table, as: table.name }] }
			}

		}

		let currentTables: JoinTable[] = [{ table, as: alias || table.name }];
		let prevTables: JoinTable[] | undefined = undefined;


		// outer:
		for (const [_i, key] of path/* .slice(0, -1) */.entries()) {
			let newTables: JoinTable[] = []
			for (const currentTable of currentTables.map(x => x.table)) {

				const schema = getSchema(currentTable.ctor);
				const field = schema.fields.find((x) => x.key === key)!;

				for (const child of currentTable.children) {

					const tableNameAs = createTableReferenceName(child, alias, field.type, join.size)
					let isMatching = child.parentPath![child.parentPath!.length - 1] === key
					if (isMatching) {
						const tableWithAlias = { table: child, as: tableNameAs }
						if (child.isSimpleValue) {
							if (!child.inline) { join.set(tableNameAs, tableWithAlias) }
							return { queryKey: FOREIGN_VALUE_PROPERTY, foreignTables: [tableWithAlias] }
						}

						newTables.push(tableWithAlias)
						if (!child.inline) { join.set(tableNameAs, tableWithAlias) }
					}

				}
			}
			prevTables = currentTables;
			currentTables = newTables

			/* if (currentTables.length > 0 && i === path.length - 2) {
				// we are at the last key in the path
				// the next key should be the query key
				break;
			} */

			if (currentTables.length === 0) {
				currentTables = prevTables;
				break;
			}
		}

		if (currentTables.length === 0) {
			throw new Error("Unexpected")
		}

		let foreignTables: JoinTable[] = currentTables.filter(x => x.table.fields.find(x => x.key === path[path.length - 1]));
		let tableToQuery: Table | undefined = foreignTables[foreignTables.length - 1].table
		let queryKeyPath = [path[path.length - 1]]
		while (tableToQuery?.inline) {
			queryKeyPath.unshift(tableToQuery!.parentPath![tableToQuery!.parentPath!.length - 1])
			tableToQuery = tableToQuery.parent
		}

		let queryKey = queryKeyPath.length > 0 ? getInlineTableFieldName(queryKeyPath.slice(0, -1), queryKeyPath[queryKeyPath.length - 1]) : FOREIGN_VALUE_PROPERTY;
		return { queryKey, foreignTables };
	} catch (error) {
		throw error;
	}
}

/* 
const resolveTableToQuery = (table: Table, tables: Map<string, Table>, join: Map<string, JoinTable>,
	path: string[], alias?: string) => {
	let foreignTables: JoinTable[] = [{ table, as: alias || table.name }];
	let queryKey = FOREIGN_VALUE_PROPERTY;

	outer:
	for (const [i, key] of path.entries()) {
		const currentTables = foreignTables.map(x => x.table);
		for (const currentTable of currentTables) {

			// TODO line below will not work if a object contains a subobject which is a inline table, that itself references a table to jon
			// this is not supported, but should be fixed
			const sqlField = currentTable.fields.find(x => x.key === key)
			if (sqlField && i === path.length - 1) {
				queryKey = sqlField.name;
				break outer;
			}

			const schema = getSchema(currentTable.ctor);
			const field = schema.fields.find((x) => x.key === key)!;
			const resolvedTables = getTableFromField(currentTable, tables, field)
			foreignTables = []

			if (!alias && (field.type instanceof VecKind || (field.type instanceof OptionKind && field.type.elementType instanceof VecKind))) {
				let aliasSuffix = "_" + String(join.size);
				alias = aliasSuffix
			}
			for (const foreignTable of resolvedTables) {
				const tableNameAs = alias ? (alias + "_" + foreignTable.name) : foreignTable.name
				let tableWithAlias = { table: foreignTable, as: tableNameAs }

				// inline tables does not need to be joined
				if (!foreignTable.inline) { join.set(tableNameAs, tableWithAlias) }

				foreignTables.push(tableWithAlias)
			}
		}

		if (i === path.length - 2) {
			const foreignTablesWithField = foreignTables.filter(t => t.table.fields.find((x) =>
				x.key === path[i + 1])
			)
			if (foreignTablesWithField.length > 0) {
				queryKey = foreignTablesWithField[0].table.fields.find((x) =>
					x.key === path[i + 1])!.name
				// path[i + 1]; 
				foreignTables = foreignTablesWithField;
				break;
			}
		}
	}

	return { queryKey, foreignTables };
} */



const convertStateFieldQuery = (
	query: types.StateFieldQuery,
	tables: Map<string, Table>,
	table: Table,
	join: Map<string, JoinTable>,
	path: string[],
	tableAlias: string | undefined = undefined
): { where: string } => {
	// if field id represented as foreign table, do join and compare
	const inlinedName = getInlineTableFieldName(query.key.slice(0, query.key.length - 1), query.key[query.key.length - 1])
	const tableField = table.fields.find(x => x.name === inlinedName) /* stringArraysEquals(query.key, [...table.parentPath, x.name]) )*/
	const isForeign = !tableField // table.fields.find(x => x.name === query.key[query.key.length - 1])
	if (isForeign) {
		const { queryKey, foreignTables } = resolveTableToQuery(table, tables, join, [...path, ...query.key], tableAlias, false);
		query = cloneQuery(query);
		query.key = [queryKey];
		let whereBuilder: string[] = []
		for (const ftable of foreignTables) {
			if (ftable.table === table) {
				throw new Error("Unexpected")
			}
			const { where } = convertQueryToSQLQuery(query, tables, ftable.table, join, path, ftable.as);
			whereBuilder.push(where);
		}
		return { where: whereBuilder.join(" OR ") };
	}

	const keyWithTable = (tableAlias || table.name) + "." + inlinedName
	let where: string;
	if (query instanceof types.StringMatch) {
		let statement = "";


		if (query.method === types.StringMatchMethod.contains) {
			statement = `${keyWithTable} LIKE '%${query.value}%'`;
		} else if (query.method === types.StringMatchMethod.prefix) {
			statement = `${keyWithTable} LIKE '${query.value}%'`;
		} else if (query.method === types.StringMatchMethod.exact) {
			statement = `${keyWithTable} = '${query.value}'`;
		}
		if (query.caseInsensitive) {
			statement += " COLLATE NOCASE";
		}
		where = statement;
	} else if (query instanceof types.ByteMatchQuery) {
		// compare Blob compule with f.value

		const statement = `${keyWithTable} = x'${toHexString(query.value)}'`;
		where = statement;
	} else if (query instanceof types.IntegerCompare) {

		if (tableField!.type === "BLOB") {
			// TODO perf
			where = `hex(${keyWithTable}) LIKE '%${toHexString(new Uint8Array([Number(query.value.value)]))}%'`;
		} else if (query.compare === types.Compare.Equal) {
			where = `${keyWithTable} = ${query.value.value}`;
		} else if (query.compare === types.Compare.Greater) {
			where = `${keyWithTable} > ${query.value.value}`;
		} else if (query.compare === types.Compare.Less) {
			where = `${keyWithTable} < ${query.value.value}`;
		} else if (query.compare === types.Compare.GreaterOrEqual) {
			where = `${keyWithTable} >= ${query.value.value}`;
		} else if (query.compare === types.Compare.LessOrEqual) {
			where = `${keyWithTable} <= ${query.value.value}`;
		} else {
			throw new Error(`Unsupported compare type: ${query.compare}`);
		}
	} else if (query instanceof types.IsNull) {
		where = `${keyWithTable} IS NULL`;
	} else if (query instanceof types.BoolQuery) {
		where = `${keyWithTable} = ${query.value}`;
	} else {
		throw new Error("Unsupported query type: " + query.constructor.name);
	}
	return { where };
};
